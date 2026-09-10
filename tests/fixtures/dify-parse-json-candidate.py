"""Embedded Dify validator: 需求解析结构校验，包含赛道逻辑、条件作用域与价格口径。"""
import json
import re

ATTEMPT = 1

TRACK_LOGIC = ('OR', 'AND', 'SINGLE', 'NONE')
SCOPES = ('creator_objective', 'creator_commercial', 'project', 'delivery')
PRICE_BASIS = ('quoted', 'rebate_net', 'unspecified')
PRICE_KEYS = ('价格', '报价', '单价', '预算')


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


def string_list(value):
    return isinstance(value, list) and all(isinstance(x, str) and x.strip() for x in value)


def validate_constraint(item, demand):
    """解析只表达条件含义：scope 路由条件归属，价格条件必须声明口径。"""
    require(isinstance(item, dict), 'constraint_schema')
    keys = set(item)
    require(keys == {'id', 'requirement', 'source_quote', 'scope'} or
            keys == {'id', 'requirement', 'source_quote', 'scope', 'price_basis'}, 'constraint_schema')
    require(all(isinstance(item[key], str) and item[key].strip()
                for key in ('id', 'requirement', 'source_quote')), 'constraint_empty_field')
    require(item['id'] == item['id'].strip(), 'constraint_id_whitespace')
    require(item['source_quote'] in demand, 'source_quote_not_in_demand')
    require(item['scope'] in SCOPES, 'constraint_scope_enum')
    price_like = item['scope'] == 'creator_commercial' and any(key in item['requirement'] for key in PRICE_KEYS)
    if 'price_basis' in item:
        require(item['price_basis'] in PRICE_BASIS, 'price_basis_enum')
    else:
        require(not price_like, 'price_basis_missing')
    return item


def validate_parse(value, demand):
    required = {'must_have', 'must_not', 'secondary_conditions', 'soft_preferences',
                'ranking_objectives', 'type_required', 'scenario_required', 'target_type_text',
                'target_tracks', 'track_logic', 'batch_conditions'}
    require(isinstance(value, dict) and set(value) == required, 'parse_schema')
    ids = []
    for group in ('must_have', 'must_not', 'secondary_conditions'):
        require(isinstance(value[group], list), 'constraint_array')
        for item in value[group]:
            validate_constraint(item, demand)
            ids.append(item['id'])
    require(len(ids) == len(set(ids)), 'duplicate_constraint_id')
    require(string_list(value['soft_preferences']), 'preference_array')
    require(string_list(value['ranking_objectives']), 'preference_array')
    require(type(value['type_required']) is bool and type(value['scenario_required']) is bool, 'parse_boolean')
    require(isinstance(value['target_type_text'], str), 'target_type_text')
    tracks = value['target_tracks']
    require(isinstance(tracks, list) and all(isinstance(x, str) and x.strip() for x in tracks), 'target_tracks')
    require(len(tracks) == len(set(tracks)), 'duplicate_target_track')
    require(value['track_logic'] in TRACK_LOGIC, 'track_logic_enum')
    require(isinstance(value['batch_conditions'], list) and all(isinstance(x, str) and x.strip() for x in value['batch_conditions']), 'batch_conditions')
    require(not value['type_required'] or bool(value['target_type_text'].strip()), 'target_type_missing')
    require(not value['type_required'] or (tracks and value['track_logic'] != 'NONE'), 'track_missing')
    require(value['track_logic'] == 'NONE' or bool(tracks), 'track_logic_without_tracks')
    require(value['track_logic'] != 'NONE' or not tracks, 'tracks_with_none_logic')
    return value


def main(raw_text: str, demand: str = ''):
    diagnostics = {'attempt': ATTEMPT, 'raw_char_count': len(raw_text) if isinstance(raw_text, str) else 0,
                   'error_kind': '', 'json_error_position': -1}
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
        value = json.loads(text, parse_constant=reject_constant, object_pairs_hook=unique_object)
        value = validate_parse(value, demand)
        return {'value': value, 'error': '', 'diagnostics': diagnostics}
    except json.JSONDecodeError as error:
        diagnostics.update(error_kind='invalid_json', json_error_position=error.pos)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as error:
        diagnostics['error_kind'] = str(error) if type(error) is ValueError else 'invalid_schema'
    return {'value': {}, 'error': '模型输出校验失败：' + diagnostics['error_kind'], 'diagnostics': diagnostics}
