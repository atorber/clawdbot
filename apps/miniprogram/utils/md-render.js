/**
 * 将 Markdown 文本转为微信 rich-text 组件的 nodes 数组。
 * 支持：**粗体**、*斜体*、`行内代码`、```代码块```、[链接](url)、# 标题、列表、换行。
 */
function textNode(text) {
  if (text == null || text === '') return [];
  return [{ type: 'text', text: String(text) }];
}

function el(name, attrs, children) {
  const node = { name: name };
  if (attrs && typeof attrs === 'object' && Object.keys(attrs).length > 0) node.attrs = attrs;
  node.children = Array.isArray(children)
    ? children
    : children != null && children !== ''
      ? [{ type: 'text', text: String(children) }]
      : [];
  return node;
}

function parseInline(str) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (str.slice(i, i + 2) === '**') {
      const end = str.indexOf('**', i + 2);
      if (end !== -1) {
        out.push(el('b', {}, parseInline(str.slice(i + 2, end))));
        i = end + 2;
        continue;
      }
    }
    if (str.slice(i, i + 1) === '*' && (i === 0 || str[i - 1] !== '*')) {
      const end = str.indexOf('*', i + 1);
      if (end !== -1 && str[end + 1] !== '*') {
        out.push(el('i', {}, parseInline(str.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    if (str.slice(i, i + 1) === '`') {
      const end = str.indexOf('`', i + 1);
      if (end !== -1) {
        out.push(el('code', { class: 'inline-code' }, textNode(str.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    const linkOpen = str.indexOf('[', i);
    const linkClose = str.indexOf(']', linkOpen);
    const parenOpen = linkClose !== -1 ? str.indexOf('(', linkClose) : -1;
    const parenClose = parenOpen === linkClose + 1 ? str.indexOf(')', parenOpen) : -1;
    if (linkOpen === i && linkClose !== -1 && parenOpen === linkClose + 1 && parenClose !== -1) {
      const text = str.slice(linkOpen + 1, linkClose);
      const href = str.slice(parenOpen + 1, parenClose);
      out.push(el('a', { href: href }, textNode(text)));
      i = parenClose + 1;
      continue;
    }
    let next = str.length;
    const markers = ['**', '*', '`', '['];
    for (const m of markers) {
      const idx = str.indexOf(m, i + (m.length > 1 ? 1 : 1));
      if (idx !== -1 && idx < next) next = idx;
    }
    if (next > i) {
      const raw = str.slice(i, next);
      if (raw.length > 0) out.push({ type: 'text', text: raw });
    }
    i = next;
  }
  return out;
}

function flattenRichChildren(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      out.push({ type: 'text', text: n.text });
    } else {
      out.push(n);
    }
  }
  return out;
}

function mdToNodes(md) {
  if (md == null || typeof md !== 'string') return [el('span', {}, textNode(''))];
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const codeFence = line.match(/^```(\w*)$/);
    if (codeFence) {
      const lang = codeFence[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const code = codeLines.join('\n');
      blocks.push(el('div', { class: 'md-code-block' }, [
        el('pre', { class: 'md-pre' }, [el('code', { class: 'md-code' }, textNode(code))]),
      ]));
      continue;
    }
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const tag = 'h' + Math.min(level, 6);
      const inner = parseInline(headerMatch[2]);
      blocks.push(el(tag, { class: 'md-' + tag }, flattenRichChildren(inner)));
      i++;
      continue;
    }
    const ulMatch = line.match(/^[\-\*]\s+(.*)$/);
    if (ulMatch) {
      const inner = parseInline(ulMatch[1]);
      blocks.push(el('div', { class: 'md-li' }, [el('span', { class: 'md-bullet' }, '• ')].concat(flattenRichChildren(inner))));
      i++;
      continue;
    }
    if (line.trim() === '') {
      blocks.push(el('div', { class: 'md-p' }, []));
      i++;
      continue;
    }
    const inner = parseInline(line);
    blocks.push(el('div', { class: 'md-p' }, flattenRichChildren(inner)));
    i++;
  }
  const rootChildren = [];
  for (const b of blocks) {
    if (b.name === 'div' && b.attrs && b.attrs.class === 'md-p' && (!b.children || b.children.length === 0)) {
      rootChildren.push(el('br', {}, []));
    } else {
      rootChildren.push(b);
    }
  }
  if (rootChildren.length === 0) rootChildren.push(el('span', {}, textNode('')));
  return rootChildren;
}

module.exports = {
  mdToNodes: mdToNodes,
};
