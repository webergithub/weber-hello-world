#!/usr/bin/env python3
"""把设计系统的 tokens.json 编译成 css/tokens.css。 Compile the design system's tokens.json into css/tokens.css.
用法 Usage: python3 tools/sync-design.py path/to/tokens.json"""
import json, sys, os
here = os.path.dirname(os.path.abspath(__file__))
t = json.load(open(sys.argv[1], encoding='utf-8'))
themes = [x['id'] for x in t['color']['themes']]
def val(tok, th):
    v = tok['value']
    return v if isinstance(v, str) else v.get(th, v[themes[0]])
out = '/* 十岁啦 成长相册 — generated from tokens.json */\n'
toks = t['color']['tokens'] + t.get('shadow', {}).get('tokens', [])
for i, th in enumerate(themes):
    sel = (':root, ' if i == 0 else '') + '[data-theme="%s"]' % th
    out += sel + ' {\n' + ''.join('  --%s: %s;\n' % (k['name'], val(k, th)) for k in toks) + '}\n'
out += ':root {\n' + ''.join('  --%s: %s;\n' % (k['name'], k['value']) for k in t['spacing']['tokens'] + t['radius']['tokens'])
out += ''.join('  --font-%s: %s;\n' % (k, v) for k, v in t['type']['families'].items()) + '}\n'
open(os.path.join(here, '..', 'css', 'tokens.css'), 'w', encoding='utf-8').write(out)
print('css/tokens.css written')
