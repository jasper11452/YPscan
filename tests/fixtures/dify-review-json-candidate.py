"""Embedded Dify validator: v3 整体复核结构校验 + 逐 id 事实一致性 + 受控缺证。"""
import json
import re

ATTEMPT = 1

DIMS = ('content_relevance', 'type_relevance')
PRIORITIES = ('优先', '备选', '后排', '暂不能判断')
CLAIM_GUARDS = (('comments', ('跟做', '提问', '追问', '复刻', '粉丝信任', '粘性', '号召')),
                ('content', ('口播', '表达清晰', '出镜', '讲解流畅', '语速')))
SCOPES = ('creator_objective', 'creator_commercial')
GAP_KINDS = ('missing_content', 'missing_comments', 'unverified_price_basis')
VERDICTS = ('PASS', 'FAIL', 'UNKNOWN')
PRICE_KEYS = ('价格', '报价', '单价', '预算')


def require(condition, error):
    if not condition:
        raise ValueError(error)


def reject_constant(value):
    raise ValueError('non_finite_json')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_key')
        result[key] = value
    return result


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
    titles = metrics = content = comments = 0
    for record in records:
        data = record.get('data') if isinstance(record, dict) else None
        if not isinstance(data, dict):
            continue
        titles += 1 if has_any(data, ('视频标题', '标题', 'title')) else 0
        metrics += 1 if has_any(data, ('播放量', '点赞量', '评论量', '转发量')) else 0
        content += 1 if has_any(data, ('正文', '内容', '视频转写', '转写', 'asr')) else 0
        comments += 1 if has_any(data, ('评论原文', '评论内容', 'comment_text')) else 0
    content_cap = 4 if content >= 3 else (3 if titles >= 3 and metrics >= 3 else (2 if titles or content else None))
    type_cap = 4 if titles >= 5 else (3 if titles or content else None)
    return {'content_relevance': content_cap, 'type_relevance': type_cap,
            'counts': {'titles': titles, 'metrics': metrics, 'content': content, 'comments': comments}}


def find_fabrications(texts, counts):
    problems = []
    for text in texts:
        if not isinstance(text, str) or not text.strip():
            continue
        for need, words in CLAIM_GUARDS:
            if counts.get(need, 0) > 0:
                continue
            hits = [word for word in words if word in text]
            if hits:
                problems.append('缺少' + need + '证据却出现表述：' + '、'.join(hits))
    return list(dict.fromkeys(problems))


def _creator_conditions(parsed):
    """当前解析出的达人条件（含分组），项目/交付条件不参与复核。"""
    out = []
    for group in ('must_have', 'must_not', 'secondary_conditions'):
        items = parsed.get(group) if isinstance(parsed, dict) else None
        items = items if isinstance(items, list) else []
        for item in items:
            if isinstance(item, dict) and item.get('scope') in SCOPES:
                out.append((group, item))
    return out


def _analysis_status(analysis):
    checks = analysis.get('constraint_results') if isinstance(analysis, dict) else None
    checks = checks if isinstance(checks, list) else []
    out = {}
    for item in checks:
        if isinstance(item, dict) and isinstance(item.get('id'), str) and isinstance(item.get('status'), str):
            out[item['id']] = item['status']
    return out


def validate_gaps(value, parsed, evidence, caps, diagnostics=None):
    """缺证说明只接受受控类别；无依据的缺口丢弃并记诊断，字段/类别非法仍报错。"""
    conditions = _creator_conditions(parsed)
    known_ids = {item.get('id') for _, item in conditions}
    price_ids = {item.get('id') for _, item in conditions
                 if item.get('price_basis') in ('rebate_net', 'unspecified')}
    gaps = value['evidence_gaps']
    require(isinstance(gaps, list), 'evidence_gap_array')
    seen = set()
    kept, dropped = [], []
    for item in gaps:
        require(isinstance(item, dict) and set(item) == {'kind', 'condition_ids'}, 'evidence_gap_schema')
        kind = item['kind']
        require(kind in GAP_KINDS, 'evidence_gap_kind')
        require(kind not in seen, 'evidence_gap_duplicate')
        seen.add(kind)
        ids = item['condition_ids']
        require(isinstance(ids, list) and all(isinstance(x, str) and x.strip() for x in ids), 'evidence_gap_ids')
        require(len(ids) == len(set(ids)), 'evidence_gap_ids_duplicate')
        reason = ''
        if not set(ids) <= known_ids:
            reason = 'unknown_condition'
        elif kind == 'missing_content' and caps['counts']['content'] > 0:
            reason = 'content_present'
        elif kind == 'missing_comments' and caps['counts']['comments'] > 0:
            reason = 'comments_present'
        elif kind == 'unverified_price_basis' and (not ids or not set(ids) <= price_ids):
            reason = 'price_condition_not_unverified'
        if reason:
            dropped.append({'kind': kind, 'condition_ids': ids, 'reason': reason})
            continue
        kept.append(item)
    value['evidence_gaps'] = kept
    if diagnostics is not None:
        diagnostics['dropped_gaps'] = dropped
    return kept


def _price_summary(conditions, reviews):
    """价格摘要只由逐 id 复核结论生成，避免与结构化 UNKNOWN 矛盾。"""
    prices = [item for _, item in conditions
              if item.get('price_basis') or any(key in str(item.get('requirement') or '') for key in PRICE_KEYS)]
    if not prices:
        return None
    order = {'FAIL': 0, 'UNKNOWN': 1, 'PASS': 2}
    labels = {'FAIL': '不满足', 'UNKNOWN': '待确认', 'PASS': '满足'}
    ranked = sorted(prices, key=lambda item: order.get(reviews[item['id']]['verdict'], 3))
    parts = []
    for item in ranked[:2]:
        text = labels[reviews[item['id']]['verdict']] + '：' + str(item.get('requirement') or '')
        if text not in parts:
            parts.append(text)
    return '；'.join(parts)[:80]


def _sanitize(value, counts):
    """删掉缺少证据的表述，保留复核档位与结论。"""
    notes = []
    for key in ('strengths', 'weaknesses'):
        kept = []
        for item in value[key]:
            if find_fabrications([item], counts):
                notes.append('已删除缺少证据的表述：' + item[:40])
            else:
                kept.append(item)
        value[key] = kept
    for key in ('strongest_support', 'main_objection', 'reason'):
        if find_fabrications([value[key]], counts):
            notes.append('已删除缺少证据的表述：' + key)
            value[key] = ''
    return notes


def validate(value, evidence, caps, analysis, parsed, diagnostics=None):
    required = {'content_relevance', 'type_relevance', 'coverage', 'priority', 'verdict',
                'strongest_support', 'main_objection', 'corrections', 'business', 'reason',
                'strengths', 'weaknesses', 'condition_reviews', 'evidence_gaps'}
    require(isinstance(value, dict) and set(value) == required, 'review_schema')
    valid_ids = {r.get('id') for r in (evidence.get('records') or [])
                 if isinstance(r, dict) and isinstance(r.get('id'), str)}
    notes = []
    for key in DIMS:
        item = value[key]
        require(isinstance(item, dict) and set(item) == {'level', 'evidence_ids', 'reason'}, 'review_item_' + key)
        level = item['level']
        require(level is None or (type(level) is int and 0 <= level <= 4), 'review_level_' + key)
        ids = item['evidence_ids']
        require(isinstance(ids, list) and all(isinstance(x, str) and x.strip() for x in ids), 'review_evidence_' + key)
        profile = evidence.get('profile') if isinstance(evidence, dict) else {}
        profile = profile if isinstance(profile, dict) else {}
        normalized_ids = []
        unknown_ids = []
        for evidence_id in ids:
            if evidence_id in valid_ids:
                normalized_ids.append(evidence_id)
                continue
            if evidence_id == 'profile':
                if profile:
                    normalized_ids.append(evidence_id)
                else:
                    unknown_ids.append(evidence_id)
                continue
            if evidence_id.startswith('profile.') and evidence_id[len('profile.'):] in profile:
                normalized_ids.append(evidence_id)
                continue
            range_match = re.fullmatch(r'R(\d+)-R?(\d+)', evidence_id)
            if range_match:
                range_start = int(range_match.group(1))
                range_end = int(range_match.group(2))
                if range_start <= range_end and range_end - range_start <= 100:
                    missing_range_ids = []
                    for index in range(range_start, range_end + 1):
                        candidate = 'R' + str(index)
                        if candidate in valid_ids:
                            normalized_ids.append(candidate)
                        else:
                            missing_range_ids.append(candidate)
                    if missing_range_ids:
                        notes.append(key + ' 已忽略范围内不存在的证据编号：' + '、'.join(missing_range_ids[:5]))
                else:
                    unknown_ids.append(evidence_id)
            else:
                unknown_ids.append(evidence_id)
        item['evidence_ids'] = list(dict.fromkeys(normalized_ids))
        ids = item['evidence_ids']
        if unknown_ids:
            notes.append(key + ' 已忽略未知证据编号：' + '、'.join(unknown_ids[:5]))
        require(isinstance(item['reason'], str) and item['reason'].strip(), 'review_reason_' + key)
        cap = caps[key]
        if level is not None:
            if cap is None:
                notes.append(key + ' 缺少可核验证据，档位下调为 null')
                item['level'] = None
                item['evidence_ids'] = []
                level = None
            elif level > cap:
                notes.append(key + ' 档位由 ' + str(level) + ' 下调为 ' + str(cap) + '（证据上限）')
                item['level'] = cap
        if level is not None and level > 0 and not ids:
            notes.append(key + ' 正面档位缺少合法证据，复核继续但需人工复核')
    coverage = value['coverage']
    require(coverage is None or (isinstance(coverage, (int, float)) and not isinstance(coverage, bool)
                                 and 0.0 <= float(coverage) <= 1.0), 'coverage_range')
    require(value['priority'] in PRIORITIES, 'priority_enum')
    require(value['verdict'] in ('推荐', '不推荐'), 'verdict_enum')
    for key in ('strongest_support', 'main_objection', 'reason'):
        require(isinstance(value[key], str), 'review_text_' + key)
    require(isinstance(value['corrections'], list), 'corrections_array')
    for item in value['corrections']:
        require(isinstance(item, dict) and set(item) == {'field', 'initial', 'final', 'reason'}, 'correction_schema')
        require(all(isinstance(item[key], str) for key in ('field', 'initial', 'final', 'reason')), 'correction_text')
    value['corrections'] = [
        '%s：%s → %s（%s）' % (item['field'], item['initial'], item['final'], item['reason'])
        for item in value['corrections']
    ]
    require(isinstance(value['business'], dict), 'business_object')
    for key in value['business']:
        require(isinstance(value['business'][key], str), 'business_value')
    for key in ('strengths', 'weaknesses'):
        require(isinstance(value[key], list) and all(isinstance(x, str) and x.strip() for x in value[key]), 'review_array_' + key)

    conditions = _creator_conditions(parsed)
    expected_ids = [item.get('id') for _, item in conditions]
    require(len(expected_ids) == len(set(expected_ids)), 'duplicate_constraint_id')
    require(isinstance(value['condition_reviews'], list), 'condition_review_array')
    reviews = {}
    for item in value['condition_reviews']:
        require(isinstance(item, dict) and set(item) == {'id', 'verdict', 'reason'}, 'condition_review_schema')
        identifier = item['id']
        require(isinstance(identifier, str) and identifier.strip(), 'condition_review_id')
        require(identifier not in reviews, 'condition_review_duplicate')
        require(item['verdict'] in VERDICTS, 'condition_review_verdict')
        require(isinstance(item['reason'], str) and item['reason'].strip(), 'condition_review_reason')
        reviews[identifier] = item
    require(set(reviews) == set(expected_ids), 'condition_review_coverage')
    validate_gaps(value, parsed, evidence, caps, diagnostics)

    program = _analysis_status(analysis)
    conflicts = []
    for group, condition in conditions:
        identifier = condition.get('id')
        verdict = reviews[identifier]['verdict']
        status = program.get(identifier)
        if status not in ('PASS', 'FAIL') or verdict not in ('PASS', 'FAIL') or status == verdict:
            continue
        detail = '条件' + str(identifier) + '复核为' + verdict + '，程序核验为' + status
        if group == 'secondary_conditions':
            notes.append('偏好条件复核与程序核验不一致：' + str(identifier))
        else:
            conflicts.append(detail)
    require(not conflicts, 'review_conflict')

    price_summary = _price_summary(conditions, reviews)
    if price_summary is not None:
        value['business']['price'] = price_summary

    texts = [value['reason'], value['strongest_support'], value['main_objection']] + value['strengths']
    fabrications = find_fabrications(texts + value['weaknesses'], caps['counts'])
    if fabrications:
        notes = notes + _sanitize(value, caps['counts'])
    if notes:
        value['weaknesses'] = value['weaknesses'] + ['证据上限修正：' + '；'.join(notes)]
    return value


def main(raw_text: str, evidence_json: str = '{}', parsed: dict = None, analysis: dict = None):
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
        value = validate(value, evidence, caps, analysis, parsed or {}, diagnostics)
        diagnostics['caps'] = caps
        return {'value': value, 'error': '', 'diagnostics': diagnostics}
    except json.JSONDecodeError as error:
        diagnostics.update(error_kind='invalid_json', json_error_position=error.pos)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as error:
        diagnostics['error_kind'] = str(error) if type(error) is ValueError else 'invalid_schema'
    return {'value': {}, 'error': '整体复核校验失败：' + diagnostics['error_kind'], 'diagnostics': diagnostics}
