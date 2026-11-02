import React from 'react';

/** 行内格式：**粗体**、`代码`；其余按纯文本显示（不插入 HTML） */
export function Inline({ text }) {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b>
    : p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <React.Fragment key={i}>{p}</React.Fragment>));
}

export const headingId = (text) => 'md-' + String(text).replace(/\s+/g, '-');

/** 渲染 mdBlocks() 的结果 */
export default function Markdown({ blocks }) {
  return (
    <div className="md-doc">
      {blocks.map((b, i) => {
        if (b.t === 'h') { const H = `h${Math.min(b.level, 4)}`; return <H key={i} id={headingId(b.text)}><Inline text={b.text} /></H>; }
        if (b.t === 'table') return (
          <table key={i}><thead><tr>{b.head.map((c, j) => <th key={j}><Inline text={c} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}><Inline text={c} /></td>)}</tr>)}</tbody></table>
        );
        if (b.t === 'ul' || b.t === 'ol') { const L = b.t; return <L key={i}>{b.items.map((x, j) => <li key={j}><Inline text={x} /></li>)}</L>; }
        if (b.t === 'quote') return <blockquote key={i}><Inline text={b.text} /></blockquote>;
        return <p key={i}><Inline text={b.text} /></p>;
      })}
    </div>
  );
}
