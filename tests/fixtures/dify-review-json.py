"""Embedded Dify validator: v3 整体复核结构校验 + 事实一致性。"""
import json
import re

ATTEMPT = 1

DIMS = ('content_relevance', 'type_relevance')
PRIORITIES = ('优先', '备选', '后排', '暂不能判断')
CLAIM_GUARDS = (('comments', ('跟做', '提问', '追问', '复刻', '粉丝信任', '粘性', '号召')),
                ('content', ('口播', '表达清晰', '出镜', '讲解流畅', '语速')))


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


def has_affirmative(text, words):
    if not isinstance(text, str):
        return False
    for word in words:
        start = 0
        while True:
            index = text.find(word, start)
            if index < 0:
                break
            prefix = text[:index]
            if not re.search(r"(?:不|未|无法|不能|没有)(?:\s|完全|充分|很)*$", prefix):
                return True
            start = index + len(word)
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


def _analysis_failures(analysis):
    """从已校验的相关度分析里取程序核验失败的条件。"""
    if not isinstance(analysis, dict):
        return []
    checks = analysis.get('constraint_results')
    checks = checks if isinstance(checks, list) else []
    return [item for item in checks if isinstance(item, dict) and item.get('status') == 'FAIL']


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


def validate(value, evidence, caps, failures):
    required = {'content_relevance', 'type_relevance', 'coverage', 'priority', 'verdict',
                'strongest_support', 'main_objection', 'corrections', 'business', 'reason',
                'strengths', 'weaknesses'}
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
    conflicts = []
    texts = [value['reason'], value['strongest_support'], value['main_objection']] + value['strengths']
    price_words = ('价格', '报价', '预算', '单价')
    claims_ok = [text for text in texts if isinstance(text, str) and has_affirmative(text, ('符合', '满足'))
                 and any(word in text for word in price_words)]
    price_failures = [item for item in failures
                      if any(word in str(item.get('evidence') or '') for word in price_words)]
    if claims_ok and price_failures:
        conflicts.append('复核称价格符合，但程序核验为超上限')
    price_state = str(value['business'].get('price') or '')
    if has_affirmative(price_state, ('满足', '符合')) and price_failures:
        conflicts.append('复核称价格满足，但程序核验为超上限')
    fabrications = find_fabrications(texts + value['weaknesses'], caps['counts'])
    require(not conflicts, 'review_conflict')
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
        value = validate(value, evidence, caps, _analysis_failures(analysis))
        diagnostics['caps'] = caps
        return {'value': value, 'error': '', 'diagnostics': diagnostics}
    except json.JSONDecodeError as error:
        diagnostics.update(error_kind='invalid_json', json_error_position=error.pos)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as error:
        diagnostics['error_kind'] = str(error) if type(error) is ValueError else 'invalid_schema'
    return {'value': {}, 'error': '整体复核校验失败：' + diagnostics['error_kind'], 'diagnostics': diagnostics}
