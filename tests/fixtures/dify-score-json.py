"""Embedded Dify validator: v3 相关度分析结构校验与证据上限。"""
import json
import re

ATTEMPT = 1

DIMS = ('content_relevance', 'type_relevance')
TITLE_KEYS = ('视频标题', '标题', 'title', 'note_title')
CONTENT_KEYS = ('正文', '内容', 'note_content', '视频转写', '转写', 'asr', 'transcript')
METRIC_KEYS = ('播放量', '点赞量', '评论量', '转发量', '播放', '点赞', '互动')


def reject_constant(value):
    raise ValueError('non_finite_json')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_key')
        result[key] = value
    return result


def require(condition, error):
    if not condition:
        raise ValueError(error)


def has_any(data, keys):
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return True
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return True
        if isinstance(value, (list, tuple, dict)) and value:
            return True
    return False


def evidence_caps(evidence):
    records = evidence.get('records') if isinstance(evidence, dict) else None
    records = records if isinstance(records, list) else []
    titles = metrics = content = 0
    for record in records:
        data = record.get('data') if isinstance(record, dict) else None
        if not isinstance(data, dict):
            continue
        titles += 1 if has_any(data, TITLE_KEYS) else 0
        metrics += 1 if has_any(data, METRIC_KEYS) else 0
        content += 1 if has_any(data, CONTENT_KEYS) else 0
    if content >= 3:
        content_cap = 4
    elif titles >= 3 and metrics >= 3:
        content_cap = 3
    elif titles >= 1 or content >= 1:
        content_cap = 2
    else:
        content_cap = None
    type_cap = 4 if titles >= 5 else (3 if titles >= 1 or content >= 1 else None)
    return {'content_relevance': content_cap, 'type_relevance': type_cap,
            'counts': {'titles': titles, 'metrics': metrics, 'content': content}}


NUMBER_PATTERN = re.compile(r'(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(千|k|K|万|w|W|元)?')
UNIT_SCALE = {'千': 1000, 'k': 1000, 'K': 1000, '万': 10000, 'w': 10000, 'W': 10000, '元': 1}
PRICE_FIELDS = (
    ('定制', ('定制视频价格', '定制视频报价', '定制短剧单集价格')),
    ('植入', ('植入视频价格', '植入视频报价')),
    ('图文', ('图文笔记价格', '图文笔记报价', '图文价格', '图文报价')),
    ('视频', ('视频笔记价格', '视频笔记报价', '视频报价')),
    ('下载', ('下载价格',)),
)


def _amount(number, unit):
    return float(number.replace(',', '')) * UNIT_SCALE.get(unit, 1)


def _field_amount(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value >= 0 else None
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r'\s*[¥￥]?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(千|k|K|万|w|W|元)?\s*', value)
    return _amount(match.group(1), match.group(2)) if match else None


def _segment(text, labels):
    positions = [text.find(label) for label in labels if text.find(label) >= 0]
    if not positions:
        return ''
    segment = text[min(positions):]
    return re.split(r'[,，;；。]', segment, maxsplit=1)[0]


def _bounds(segment):
    matches = list(NUMBER_PATTERN.finditer(segment))
    if not matches:
        return None
    if len(matches) >= 2 and re.fullmatch(r'\s*(?:-|~|—|–|至|到)\s*', segment[matches[0].end():matches[1].start()]):
        first_unit = matches[0].group(2) or matches[1].group(2)
        lower = _amount(matches[0].group(1), first_unit)
        upper = _amount(matches[1].group(1), matches[1].group(2))
        return {'min': min(lower, upper), 'max': max(lower, upper),
                'min_inclusive': True, 'max_inclusive': True}
    value = _amount(matches[0].group(1), matches[0].group(2))
    if re.search(r'不超过|不高于|不大于|不多于|至多|最多|最高|以内|以下|上限|<=|≤', segment):
        return {'min': None, 'max': value, 'min_inclusive': True, 'max_inclusive': True}
    if re.search(r'(?<!不)低于|(?<!不)少于|(?<!不)小于|(?<![<])<(?![=])', segment):
        return {'min': None, 'max': value, 'min_inclusive': True, 'max_inclusive': False}
    if re.search(r'不低于|不少于|不小于|至少|最低|以上|起|>=|≥', segment):
        return {'min': value, 'max': None, 'min_inclusive': True, 'max_inclusive': True}
    if re.search(r'(?<!不)高于|(?<!不)多于|(?<!不)大于|(?<![>])>(?![=])', segment):
        return {'min': value, 'max': None, 'min_inclusive': False, 'max_inclusive': True}
    return None


def _check_value(value, bounds):
    lower = bounds.get('min')
    upper = bounds.get('max')
    if lower is not None and (value < lower or (value == lower and not bounds['min_inclusive'])):
        return 'FAIL'
    if upper is not None and (value > upper or (value == upper and not bounds['max_inclusive'])):
        return 'FAIL'
    return 'PASS'


def _format_amount(value):
    return str(int(value)) if float(value).is_integer() else str(round(value, 2))


def _format_bounds(bounds):
    left = '[' if bounds.get('min_inclusive') else '('
    right = ']' if bounds.get('max_inclusive') else ')'
    lower = '-∞' if bounds.get('min') is None else _format_amount(bounds['min'])
    upper = '+∞' if bounds.get('max') is None else _format_amount(bounds['max'])
    return left + lower + ',' + upper + right


def _creator_fields(evidence):
    if not isinstance(evidence, dict):
        return {}
    for key in ('profile', 'creator'):
        value = evidence.get(key)
        if isinstance(value, dict):
            return value
    return {}


def _price_groups(fields):
    groups = {}
    for form, names in PRICE_FIELDS:
        values = []
        for name in names:
            if name not in fields:
                continue
            value = _field_amount(fields.get(name))
            if value is None:
                values.append((name, None))
            else:
                values.append((name, value))
        if values:
            groups[form] = values
    return groups


def _price_check(identifier, text, fields):
    segment = _segment(text, ('价格', '报价', '单价', '预算'))
    bounds = _bounds(segment)
    if bounds is None:
        return {'id': identifier, 'status': 'UNKNOWN',
                'evidence': text + '：价格条件无法无损解析'}
    groups = _price_groups(fields)
    if '定制' in text:
        explicit = ['定制']
    elif '植入' in text:
        explicit = ['植入']
    else:
        explicit = [form for form in ('图文', '视频', '下载') if form in text]
    if len(explicit) > 1:
        return {'id': identifier, 'status': 'UNKNOWN',
                'evidence': text + '：同时涉及多个报价形式，需分别核实'}
    if explicit:
        form = explicit[0]
    elif len(groups) == 1:
        form = next(iter(groups))
    else:
        return {'id': identifier, 'status': 'UNKNOWN',
                'evidence': text + '：报价形式缺失或存在多个候选'}
    values = groups.get(form, [])
    if not values or any(value is None for _, value in values):
        return {'id': identifier, 'status': 'UNKNOWN',
                'evidence': text + '：' + form + '报价缺失或单位无法确认'}
    distinct = {value for _, value in values}
    if len(distinct) != 1:
        detail = '、'.join(name + '=' + _format_amount(value) for name, value in values)
        return {'id': identifier, 'status': 'UNKNOWN',
                'evidence': text + '：同一报价形式字段冲突（' + detail + '）'}
    value = next(iter(distinct))
    status = _check_value(value, bounds)
    return {'id': identifier, 'status': status,
            'evidence': text + '：' + form + '报价=' + _format_amount(value) +
                        '，要求' + _format_bounds(bounds)}


def _follower_check(identifier, text, fields):
    segment = _segment(text, ('粉丝数', '粉丝量', '粉丝'))
    bounds = _bounds(segment)
    if bounds is None:
        return {'id': identifier, 'status': 'UNKNOWN',
                'evidence': text + '：粉丝条件无法无损解析'}
    value = _field_amount(fields.get('粉丝数'))
    if value is None:
        return {'id': identifier, 'status': 'UNKNOWN',
                'evidence': text + '：粉丝数缺失或单位无法确认'}
    return {'id': identifier, 'status': _check_value(value, bounds),
            'evidence': text + '：粉丝数=' + _format_amount(value) +
                        '，要求' + _format_bounds(bounds)}


def deterministic_checks(parsed, evidence):
    """程序核验明确的价格与粉丝范围，无法无损判断时覆盖为 UNKNOWN。"""
    fields = _creator_fields(evidence)
    results = []
    for item in parsed.get('must_have') or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get('requirement') or '')
        identifier = item.get('id')
        if any(key in text for key in ('价格', '报价', '单价', '预算')):
            results.append(_price_check(identifier, text, fields))
        elif '粉丝' in text:
            results.append(_follower_check(identifier, text, fields))
    return results


def validate(value, parsed, evidence, caps):
    required = {'content_relevance', 'type_relevance', 'coverage', 'constraint_results',
                'requirements_complete', 'brief', 'strengths', 'weaknesses', 'reason'}
    require(isinstance(value, dict) and set(value) == required, 'relevance_schema')
    valid_ids = {r.get('id') for r in (evidence.get('records') or [])
                 if isinstance(r, dict) and isinstance(r.get('id'), str)}
    notes = []
    for key in DIMS:
        item = value[key]
        require(isinstance(item, dict) and set(item) == {'level', 'evidence_ids', 'reason'}, 'relevance_item_' + key)
        level = item['level']
        require(level is None or (type(level) is int and 0 <= level <= 4), 'relevance_level_' + key)
        ids = item['evidence_ids']
        require(isinstance(ids, list) and all(isinstance(x, str) and x.strip() for x in ids), 'relevance_evidence_' + key)
        require(len(ids) == len(set(ids)), 'relevance_evidence_duplicate_' + key)
        require(set(ids) <= valid_ids, 'unknown_evidence_id')
        require(isinstance(item['reason'], str) and item['reason'].strip(), 'relevance_reason_' + key)
        cap = caps[key]
        if level is not None:
            if cap is None:
                notes.append(key + ' 缺少可核验证据，档位由 ' + str(level) + ' 下调为 null')
                item['level'] = None
                item['evidence_ids'] = []
                level = None
            elif level > cap:
                notes.append(key + ' 档位由 ' + str(level) + ' 下调为 ' + str(cap) + '（证据上限）')
                item['level'] = cap
                level = cap
        if level is not None:
            require(bool(ids), 'relevance_evidence_required_' + key)
    coverage = value['coverage']
    require(coverage is None or (isinstance(coverage, (int, float)) and not isinstance(coverage, bool)
                                 and 0.0 <= float(coverage) <= 1.0), 'coverage_range')
    require(type(value['requirements_complete']) is bool, 'relevance_boolean')
    require(isinstance(value['brief'], str), 'relevance_brief')
    for key in ('strengths', 'weaknesses'):
        require(isinstance(value[key], list) and all(isinstance(x, str) and x.strip() for x in value[key]), 'relevance_array_' + key)
    require(isinstance(value['reason'], str) and value['reason'].strip(), 'relevance_reason')
    expected = []
    for group in ('must_have', 'must_not', 'secondary_conditions'):
        require(isinstance(parsed.get(group), list), 'upstream_parse_error')
        expected.extend(item['id'] for item in parsed[group])
    require(len(expected) == len(set(expected)), 'duplicate_constraint_id')
    require(isinstance(value['constraint_results'], list), 'constraint_results_array')
    actual = []
    for item in value['constraint_results']:
        require(isinstance(item, dict) and set(item) == {'id', 'status', 'evidence'}, 'constraint_result_schema')
        require(isinstance(item['id'], str) and item['id'].strip(), 'constraint_result_id')
        require(item['status'] in ('PASS', 'FAIL', 'UNKNOWN'), 'constraint_result_status')
        require(isinstance(item['evidence'], str) and item['evidence'].strip(), 'constraint_result_evidence')
        actual.append(item['id'])
    require(len(actual) == len(set(actual)) and set(actual) == set(expected), 'constraint_result_coverage')
    merged = {}
    for item in value['constraint_results']:
        merged[item['id']] = item
    for item in deterministic_checks(parsed, evidence):
        if item.get('id') in merged:
            merged[item['id']] = item
    value['constraint_results'] = list(merged.values())
    if notes:
        value['weaknesses'] = value['weaknesses'] + ['证据上限修正：' + '；'.join(notes)]
    return value


def main(raw_text: str, parsed: dict = None, evidence_json: str = '{}'):
    diagnostics = {'attempt': ATTEMPT, 'raw_char_count': len(raw_text) if isinstance(raw_text, str) else 0,
                   'error_kind': '', 'json_error_position': -1, 'caps': {}}
    try:
        require(isinstance(raw_text, str) and raw_text.strip(), 'empty_response')
        text = raw_text.strip()
        if text.startswith('<think>'):
            closing = text.find('</think>')
            require(closing >= 0, 'unfinished_thinking')
            text = text[closing + len('</think>'):].strip()
        fenced = re.fullmatch(r'```(?:json)?\s*([\s\S]*?)\s*```', text, re.IGNORECASE)
        if fenced:
            text = fenced.group(1).strip()
        evidence = json.loads(evidence_json)
        require(isinstance(evidence, dict), 'invalid_evidence')
        caps = evidence_caps(evidence)
        value = json.loads(text, parse_constant=reject_constant, object_pairs_hook=unique_object)
        value = validate(value, parsed or {}, evidence, caps)
        diagnostics['caps'] = caps
        return {'value': value, 'error': '', 'diagnostics': diagnostics}
    except json.JSONDecodeError as error:
        diagnostics.update(error_kind='invalid_json', json_error_position=error.pos)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as error:
        diagnostics['error_kind'] = str(error) if type(error) is ValueError else 'invalid_schema'
    return {'value': {}, 'error': '模型输出校验失败：' + diagnostics['error_kind'], 'diagnostics': diagnostics}
