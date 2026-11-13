type MarkdownAstNode = {
  type?: string
  depth?: number
  children?: MarkdownAstNode[]
  data?: { hProperties?: Record<string, unknown> }
}

/** 为 H1~H3 标题添加与 outline-model 相同顺序的文档内定位索引。 */
export function remarkHeadingIndices() {
  return (tree: unknown): void => {
    let headingIndex = 0
    const visit = (node: MarkdownAstNode): void => {
      if (node.type === 'heading' && node.depth !== undefined && node.depth <= 3) {
        node.data ??= {}
        node.data.hProperties = {
          ...node.data.hProperties,
          'data-heading-index': headingIndex,
        }
        headingIndex += 1
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree as MarkdownAstNode)
  }
}
