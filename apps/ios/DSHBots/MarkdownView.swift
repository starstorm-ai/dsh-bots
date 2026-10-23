import SwiftUI

/// Native selectable Markdown. Fences remain literal, horizontally scrollable and copyable.
struct MarkdownView: View {
    let text: String
    @State private var expanded = false
    struct Block: Identifiable { var id: Int; var kind: String; var text: String; var language = "" }
    static func blocks(_ source: String) -> [Block] {
        var result: [Block] = [], lines: [String] = [], fence: String?, language = ""
        func flush(_ kind: String) { if !lines.isEmpty { result.append(Block(id: result.count, kind: kind, text: lines.joined(separator: "\n"), language: language)); lines = [] } }
        for line in source.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(marker) { flush("code"); fence = nil; language = "" } else { lines.append(line) }; continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { flush("text"); fence = String(trimmed.prefix(3)); language = String(trimmed.dropFirst(3)); continue }
            if trimmed.isEmpty { flush("text") } else { lines.append(line) }
        }
        flush(fence == nil ? "text" : "code"); return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Self.blocks(expanded || text.count < 10000 ? text : String(text.prefix(10000)))) { block in
                if block.kind == "code" {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack { Text(block.language.isEmpty ? "代码" : block.language); Spacer(); Button { UIPasteboard.general.string = block.text } label: { Label("复制", systemImage: "doc.on.doc") } }.font(.caption).foregroundStyle(DSHTheme.secondary).padding(10)
                        Divider()
                        ScrollView(.horizontal) { Text(block.text).font(.system(.subheadline, design: .monospaced)).textSelection(.enabled).padding(12).fixedSize(horizontal: true, vertical: false) }
                    }.background(DSHTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                } else if block.text.contains("|") && block.text.components(separatedBy: "\n").contains(where: { $0.contains("---") && $0.contains("|") }) {
                    table(block.text)
                } else {
                    VStack(alignment: .leading, spacing: 6) { ForEach(Array(block.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in markdownLine(line) } }
                }
            }
            if text.count >= 10000 { Button(expanded ? "收起长消息" : "展开完整消息") { expanded.toggle() }.font(.caption) }
        }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
    }
    @ViewBuilder private func markdownLine(_ line: String) -> some View {
        let heading = line.prefix(while: { $0 == "#" }).count
        if heading > 0 && heading <= 6 && line.dropFirst(heading).hasPrefix(" ") { inline(String(line.dropFirst(heading + 1))).font(heading <= 2 ? .title3.weight(.semibold) : .headline) }
        else if line.hasPrefix("> ") { HStack(alignment: .top) { Rectangle().fill(DSHTheme.border).frame(width: 3); inline(String(line.dropFirst(2))).foregroundStyle(DSHTheme.secondary) }.fixedSize(horizontal: false, vertical: true) }
        else if line == "---" || line == "***" { Divider() }
        else if line.hasPrefix("- ") || line.hasPrefix("* ") { HStack(alignment: .top, spacing: 8) { Text("•"); inline(String(line.dropFirst(2))) } }
        else { inline(line) }
    }
    private func inline(_ value: String) -> Text { Text((try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)) }
    private func table(_ value: String) -> some View {
        let rows = value.components(separatedBy: "\n").filter { !($0.contains("---") && $0.contains("|")) }.map { line in line.trimmingCharacters(in: CharacterSet(charactersIn: "| ")).components(separatedBy: "|") }
        return ScrollView(.horizontal) { Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in inline(cell.trimmingCharacters(in: .whitespaces)).fontWeight(i == 0 ? .semibold : .regular).frame(minWidth: 75, alignment: .leading) } } }
        }.padding(12) }.background(DSHTheme.surface, in: RoundedRectangle(cornerRadius: 8))
    }
}
