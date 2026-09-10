"""v3 汇总：内容相关度 + 类型相关度决定分数与结论，商务未知不阻断。"""
import json

DIMS = ('content_relevance', 'type_relevance')
CLAIM_GUARDS = (('comments', ('跟做', '提问', '追问', '复刻', '粉丝信任', '粘性', '号召')),
                ('content', ('口播', '表达清晰', '出镜', '讲解流畅', '语速')))
PLATFORM_ALIASES = {'抖音': 'douyin', 'douyin': 'douyin', '小红书': 'xiaohongshu',
                    'xiaohongshu': 'xiaohongshu', 'xhs': 'xiaohongshu', '视频号': 'shipinhao',
                    'shipinhao': 'shipinhao', 'b站': 'bilibili', '哔哩哔哩': 'bilibili',
                    'bilibili': 'bilibili', '快手': 'kuaishou', 'kuaishou': 'kuaishou'}


def _int(value, low, high):
    return value if type(value) is int and low <= value <= high else None


def _strings(value):
    return [item for item in value if isinstance(item, str) and item.strip()] if isinstance(value, list) else []


def _clip(text, limit):
    value = text.strip() if isinstance(text, str) else ''
    if len(value) <= limit:
        return value
    prefix = value[:limit]
    end = max(prefix.rfind(mark) for mark in ('。', '！', '？', '；', '\n'))
    if end >= 0:
        return prefix[:end + 1].strip()
    return value[:max(0, limit - 1)].rstrip('；，。、 ') + '…'


def _tidy_evidence(text):
    """系统核验依据去掉字段路径前缀和结尾标点，便于直接展示。"""
    value = str(text or '').strip()
    for prefix in ('profile.', 'records.', 'data.'):
        value = value.replace(prefix, '')
    return value.rstrip('。；，、 ')


EVIDENCE_QUALITY_PREFIX = '证据上限修正：'
COPY_DIAGNOSTIC_PREFIXES = (EVIDENCE_QUALITY_PREFIX, '文案校验：', '整体复核未通过：',
                            '相似度未计算（', '已删除缺少证据的表述：')


def _copy_items(value, counts):
    """用户文案与内部诊断分开，保留既有证据过滤。"""
    texts = list(dict.fromkeys(item.strip() for item in _strings(value)))
    diagnostics = [item for item in texts if item.startswith(COPY_DIAGNOSTIC_PREFIXES)]
    texts = [item for item in texts if not item.startswith(COPY_DIAGNOSTIC_PREFIXES)]
    kept, removed = _strip(texts, counts)
    return kept, diagnostics + ['文案校验：已删除缺少证据的表述：' + item for item in removed]


def _has_evidence_quality_alert(source):
    return isinstance(source, dict) and any(
        item.startswith(EVIDENCE_QUALITY_PREFIX)
        for item in _strings(source.get('weaknesses'))
    )


NON_CREATOR_WORDS = ('返点', '综合分', '提报截止', '提交截止', '报名截止', '截止时间')


def _creator_side(label):
    text = label if isinstance(label, str) else ''
    return not any(word in text for word in NON_CREATOR_WORDS)


def _num(value):
    if value is None:
        return None
    return int(value) if float(value).is_integer() else round(value, 2)


def _levels(source):
    if not isinstance(source, dict):
        return {}
    out = {}
    for key in DIMS:
        item = source.get(key)
        if isinstance(item, dict):
            out[key] = _int(item.get('level'), 0, 4)
    return out


def _score(levels, coverage):
    content, type_level = levels.get('content_relevance'), levels.get('type_relevance')
    if content is None or type_level is None:
        return None
    score = 100.0 * (content + type_level) / 8.0
    if isinstance(coverage, (int, float)) and not isinstance(coverage, bool) and 0.0 <= float(coverage) <= 1.0:
        score += (float(coverage) - 0.5) * 4.0
    return round(max(0.0, min(100.0, score)), 1)


def _tier(score):
    if score is None:
        return None
    if score >= 85.0:
        return '首选'
    if score >= 72.0:
        return '次选'
    if score >= 60.0:
        return '备选'
    return '不推荐'


def _normalize_platform(text):
    if not isinstance(text, str):
        return ''
    value = text.strip().lower()
    return PLATFORM_ALIASES.get(value, value)


def _constraint(requirement, checks):
    identifier = requirement.get('id')
    matches = [item for item in checks if isinstance(item, dict) and item.get('id') == identifier]
    if not isinstance(identifier, str) or not identifier.strip() or len(matches) != 1:
        return 'UNKNOWN', '资料未提供可核验信息', identifier
    status = matches[0].get('status')
    proof = matches[0].get('evidence')
    if status not in ('PASS', 'FAIL', 'UNKNOWN') or not isinstance(proof, str) or not proof.strip():
        return 'UNKNOWN', '缺少有效核验依据', identifier
    return status, proof.strip(), identifier


def _counts(evidence_json):
    try:
        evidence = json.loads(evidence_json)
    except (ValueError, TypeError):
        return {'comments': 0, 'content': 0}
    counts = {'comments': 0, 'content': 0}
    for record in (evidence.get('records') or []) if isinstance(evidence, dict) else []:
        data = record.get('data') if isinstance(record, dict) else None
        if not isinstance(data, dict):
            continue
        if any(isinstance(data.get(k), str) and data.get(k).strip() for k in ('评论原文', '评论内容', 'comment_text')):
            counts['comments'] += 1
        if any(isinstance(data.get(k), str) and data.get(k).strip() for k in ('正文', '内容', '视频转写', '转写', 'asr')):
            counts['content'] += 1
    return counts


def _strip(texts, counts):
    kept, removed = [], []
    for item in texts:
        bad = False
        for need, words in CLAIM_GUARDS:
            if counts.get(need, 0) > 0:
                continue
            if any(word in item for word in words):
                bad = True
        (removed if bad else kept).append(item)
    return kept, removed


def _diag(value):
    """把上游 diagnostics 压成浅层结构：去掉 output 包装、扁掉 caps.counts。"""
    data = value
    if isinstance(data, dict) and isinstance(data.get('output'), dict):
        data = data['output']
    if not isinstance(data, dict):
        return {}
    out = {}
    for key in ('attempt', 'error_kind', 'raw_char_count', 'json_error_position'):
        if key in data:
            out[key] = data[key]
    caps = data.get('caps')
    if isinstance(caps, dict):
        out['caps'] = {k: v for k, v in caps.items() if not isinstance(v, (dict, list))}
        counts = caps.get('counts')
        if isinstance(counts, dict):
            out['evidence_counts'] = {k: v for k, v in counts.items() if not isinstance(v, (dict, list))}
    return out


def main(scored: dict, similarity, platform: str, parse_status: str, normalized_platform: str,
         completeness_score, parsed: dict, evidence_json: str, parse_error: str = '', score_error: str = '',
         embedding_warning: str = '', vision_warning: str = '', data_warning: str = '',
         embedding_status: str = '', vision_status: str = '', deterministic_audit: dict = None,
         embedding_diagnostics: dict = None, vision_diagnostics: dict = None,
         parse_diagnostics: dict = None, score_diagnostics: dict = None, image_urls_text: str = '',
         reviewed: dict = None, review_error: str = ''):
    scored = scored if isinstance(scored, dict) else {}
    parsed = parsed if isinstance(parsed, dict) else {}
    audit = deterministic_audit if isinstance(deterministic_audit, dict) else {}
    system_error = ''
    if score_error:
        system_error = '相关度分析解析失败：' + str(score_error)
    elif parse_error:
        system_error = '需求解析失败：' + str(parse_error)

    counts = _counts(evidence_json)
    levels = _levels(scored)
    coverage = scored.get('coverage')
    review_status = 'not_run'
    if isinstance(reviewed, dict) and reviewed:
        review_levels = _levels(reviewed)
        if all(review_levels.get(key) is not None for key in DIMS):
            levels = review_levels
            coverage = reviewed.get('coverage')
            review_status = 'ok'
    elif review_error:
        review_status = 'failed'

    evidence_quality_alert = _has_evidence_quality_alert(reviewed) or _has_evidence_quality_alert(scored)
    needs_manual_review = review_status != 'ok' or evidence_quality_alert

    score = _score(levels, coverage)
    tier = _tier(score)

    hard_failed, pending, advisory = [], [], []
    checks = scored.get('constraint_results')
    checks = checks if isinstance(checks, list) else []
    for group in ('must_have', 'must_not'):
        requirements = parsed.get(group)
        if not isinstance(requirements, list):
            pending.append({'id': group, 'status': 'UNKNOWN', 'evidence': '需求解析缺少有效的' + group})
            continue
        for requirement in requirements:
            if not isinstance(requirement, dict):
                pending.append({'id': 'unknown', 'status': 'UNKNOWN', 'evidence': '数据要求格式无效'})
                continue
            label = requirement.get('requirement')
            if not isinstance(label, str) or not label.strip():
                pending.append({'id': str(requirement.get('id')), 'status': 'UNKNOWN', 'evidence': '缺少条件描述'})
                continue
            if not _creator_side(label):
                continue
            state, proof, identifier = _constraint(requirement, checks)
            record = {'id': identifier, 'status': state,
                      'evidence': proof if proof.startswith(label) else label + '：' + proof}
            if state == 'FAIL':
                hard_failed.append(record)
            elif state != 'PASS':
                pending.append(record)
    for requirement in parsed.get('secondary_conditions') or []:
        if not isinstance(requirement, dict):
            advisory.append({'id': 'unknown', 'status': 'UNKNOWN', 'evidence': '次要条件格式错误，待核实'})
            continue
        label = requirement.get('requirement')
        label = label if isinstance(label, str) and label.strip() else '次要条件'
        if not _creator_side(label):
            continue
        state, proof, identifier = _constraint(requirement, checks)
        if state != 'PASS':
            advisory.append({'id': identifier, 'status': state, 'evidence': label + '：' + proof})
    if audit.get('confirmed') is True:
        for check in audit.get('checks') or []:
            if not isinstance(check, dict):
                continue
            record = {'id': check.get('id'), 'status': check.get('status'),
                      'evidence': '附加规则：' + str(check.get('evidence') or check.get('id'))}
            if check.get('status') == 'FAIL':
                hard_failed.append(record)
            elif check.get('status') in ('UNKNOWN', 'REVIEW'):
                pending.append(record)

    mismatch = bool(platform and normalized_platform
                    and _normalize_platform(platform) != _normalize_platform(normalized_platform))
    missing = bool(platform) and not normalized_platform
    status = 'ok'
    if system_error:
        status = 'system_error'
    elif parse_status in ('invalid', 'empty') or mismatch or missing or str(audit.get('error') or ''):
        status = 'invalid_input'
    elif hard_failed:
        status = 'hard_constraint_fail'
    elif score is None:
        status = 'insufficient_data'
    if status == 'system_error':
        tier, decision, final_score = '评分失败', '不推荐', 0
    elif status == 'invalid_input':
        tier, decision, final_score = '达人数据', '不推荐', 0
    elif status == 'hard_constraint_fail':
        tier, decision, final_score = '硬约束失败', '不推荐', score if score is not None else 0
    elif status == 'insufficient_data':
        tier, decision, final_score = '数据不足', '不推荐', 0
    else:
        content, type_level = levels.get('content_relevance'), levels.get('type_relevance')
        can_recommend = (content is not None and content >= 2 and type_level is not None
                         and type_level >= 2 and score is not None and score >= 60.0)
        decision = '推荐' if can_recommend else '不推荐'
        final_score = score

    # 分数、档位和结论沿用原规则；三个文案字段统一使用有效复核。
    copy_source = reviewed if review_status == 'ok' else scored
    strengths, copy_notes = _copy_items(copy_source.get('strengths'), counts)
    weaknesses, notes = _copy_items(copy_source.get('weaknesses'), counts)
    copy_notes += notes
    strengths = [_clip(item, 60) for item in strengths[:3]]
    # 已确认的硬条件优先展示；未知不包装成达人短板。系统核验只留条件名，细节交给推荐理由。
    weaknesses = ['不满足本次硬条件：' + _tidy_evidence(item['evidence']).split('：')[0]
                  for item in hard_failed] + weaknesses
    weaknesses += ['参考条件：' + _tidy_evidence(item['evidence']).split('：')[0]
                   for item in advisory if item['status'] == 'FAIL']
    weaknesses = list(dict.fromkeys(weaknesses))[:2]
    corrections = []
    if isinstance(reviewed, dict):
        corrections = list(reviewed.get('corrections')) if isinstance(reviewed.get('corrections'), list) else []
    corrections += copy_notes

    if status == 'system_error':
        reason = '本次未完成有效评估，需重新运行；不代表达人不符合需求。'
    elif status == 'invalid_input':
        reason = '达人资料无效、平台信息缺失或不一致，需核对资料后重新评估。'
    elif status == 'hard_constraint_fail':
        detail = '；'.join(_tidy_evidence(item['evidence']) for item in hard_failed[:2])
        reason = '已确认不满足本次硬条件，不进入候选：' + detail + '。'
    elif status == 'insufficient_data':
        reason = '现有资料不足以判断内容与类型是否符合需求，需补充相关作品后复核。'
    else:
        reasons, notes = _copy_items([copy_source.get('reason')], counts)
        corrections += notes
        # 校验下调档位后，复核 verdict 可能与程序结论不同，不复用相反的提报建议。
        verdict_conflict = review_status == 'ok' and reviewed.get('verdict') not in (None, decision)
        if not reasons or verdict_conflict:
            reasons = []
            for key in DIMS:
                item = copy_source.get(key)
                if isinstance(item, dict) and isinstance(item.get('reason'), str):
                    reasons.append(item['reason'].strip().rstrip('。；， ') + '。')
            reasons, notes = _copy_items(reasons, counts)
            corrections += notes
        reason = ''.join(reasons) or '关键匹配依据尚未形成有效说明，需人工核对相关作品。'
        if verdict_conflict and decision == '不推荐':
            reason = '内容与类型尚未同时达到本次候选要求。' + reason
        suffix = ''
        if pending:
            labels = list(dict.fromkeys(str(item['evidence']).split('：')[0] for item in pending))
            suffix += '待确认：' + '、'.join(_clip(label, 18) for label in labels[:2]) + '。'
        if review_status == 'failed':
            suffix += '整体复核未完成，暂采用初评，需人工复核。'
        reason = _clip(reason, max(30, 70 - len(suffix)))
        if suffix and reason and reason[-1] not in '。！？；…':
            reason += '。'
        reason += suffix
    reason = _clip(reason, 90)

    try:
        evidence = json.loads(evidence_json)
    except (ValueError, TypeError):
        evidence = {}
    sample_links = []
    for row in evidence.get('records', []) if isinstance(evidence, dict) else []:
        data = row.get('data', {}) if isinstance(row, dict) else {}
        links = [data[k] for k in ('笔记链接', '视频链接', '链接', 'url', '笔记URL', '视频URL', '视频url')
                 if isinstance(data.get(k), str) and data[k].startswith(('https://', 'http://'))]
        sample_links.append({'record_id': row.get('id'), 'urls': list(dict.fromkeys(links)), 'link_missing': not bool(links)})

    result = {
        'final_score': final_score, 'tier': tier,
        'type_match_score': round((levels.get('type_relevance') or 0) * 7.5, 1),
        'scenario_match_score': round((levels.get('content_relevance') or 0) * 7.5, 1),
        'content_quality_score': round((levels.get('content_relevance') or 0) * 25.0, 1), 'risk_penalty': 0,
        'similarity': similarity if embedding_status == 'available' and isinstance(similarity, (int, float)) else 0.0,
        'decision': decision, 'reason': reason,
        'strengths': strengths, 'weaknesses': weaknesses,
        'platform': platform or '', 'normalized_platform': normalized_platform or '',
        'platform_mismatch': mismatch, 'parse_status': parse_status or '',
        'completeness_score': completeness_score, 'evaluation_status': 'review_failed' if review_status == 'failed' else status,
        'schema_version': '3.0', 'content_score': final_score if status not in ('system_error', 'invalid_input') else None,
        'content_score_status': 'unavailable' if score is None else ('evaluated' if status == 'ok' else 'provisional'),
        'score_valid': status == 'ok', 'recommendation_scope': 'candidate_only',
        'manual_review_required': needs_manual_review, 'manual_review_completed': not needs_manual_review,
        'review_checklist': ['核对内容与类型相关度是否引用了真实作品证据',
                             '核对价格、返点、档期等商务条件是否已确认；未知不等于不满足',
                             '打开样本链接抽查作品，确认账号主线与需求场景一致',
                             '确认没有把未知信息写成已满足或已不满足',
                             '确认复核无效时已显式标记，不得采用未复核结论'],
        'deterministic_audit': audit, 'failed_checks': hard_failed, 'pending_checks': pending,
        'service_status': {'vision': vision_status, 'embedding': embedding_status},
        'service_diagnostics': {'vision': _diag(vision_diagnostics), 'embedding': _diag(embedding_diagnostics)},
        'model_output_diagnostics': {'parse': _diag(parse_diagnostics), 'score': _diag(score_diagnostics),
                                     'review': {'status': review_status,
                                                'corrections': [str(item)[:200] for item in corrections[:5]]}},
        'similarity_available': embedding_status == 'available',
        'sample_links': sample_links, 'image_sources': [u for u in image_urls_text.splitlines() if u],
        'evidence_limitations': evidence.get('limitations', '') if isinstance(evidence, dict) else '',
        'score_contract': 'v3：内容相关度+类型相关度决定综合分与推荐结论；价格/流量/返点/档期只作参考不参与档位；'
                          '商务未知不阻断推荐，只标注待确认；输出前经整体复核，复核无效则显式标记复核失败；'
                          '价格与粉丝数等确定性条件由程序核验，模型不得改写金额事实。',
    }
    return {'score_result': result}
