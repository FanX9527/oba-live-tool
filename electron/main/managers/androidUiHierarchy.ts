function decodeXmlAttribute(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function parseBounds(value: string): AndroidUiBounds | null {
  const match = value.match(/^\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]$/)
  if (!match) return null
  const [, left, top, right, bottom] = match.map(Number)
  if (right <= left || bottom <= top) return null
  return {
    left,
    top,
    right,
    bottom,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2),
  }
}

function parseNodeAttributes(source: string) {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlAttribute(match[2])
  }
  return attributes
}

export function parseAndroidUiHierarchy(xml: string): AndroidUiNode[] {
  const nodes: AndroidUiNode[] = []
  const parentStack: number[] = []
  for (const match of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (match[0] === '</node>') {
      parentStack.pop()
      continue
    }
    const attributes = parseNodeAttributes(match[1] ?? '')
    const index = nodes.length
    nodes.push({
      index,
      parentIndex: parentStack.at(-1) ?? null,
      text: attributes.text ?? '',
      resourceId: attributes['resource-id'] ?? '',
      className: attributes.class ?? '',
      packageName: attributes.package ?? '',
      contentDescription: attributes['content-desc'] ?? '',
      clickable: attributes.clickable === 'true',
      enabled: attributes.enabled !== 'false',
      focused: attributes.focused === 'true',
      scrollable: attributes.scrollable === 'true',
      selected: attributes.selected === 'true',
      bounds: parseBounds(attributes.bounds ?? ''),
    })
    if (match[2] !== '/') parentStack.push(index)
  }
  return nodes
}

export function normalizeUiText(value: string) {
  return value.normalize('NFKC').trim().toLowerCase()
}

export function nodeTexts(node: AndroidUiNode) {
  return [node.text, node.contentDescription, node.resourceId].filter(Boolean)
}

export function nodeContains(node: AndroidUiNode, values: string[]) {
  const normalizedValues = values.map(normalizeUiText).filter(Boolean)
  return nodeTexts(node).some(text => {
    const normalized = normalizeUiText(text)
    return normalizedValues.some(value => normalized.includes(value))
  })
}

export function nodeEquals(node: AndroidUiNode, values: string[]) {
  const normalizedValues = new Set(values.map(normalizeUiText).filter(Boolean))
  return nodeTexts(node).some(text => normalizedValues.has(normalizeUiText(text)))
}
