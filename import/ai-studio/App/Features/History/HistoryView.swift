import SwiftData
import SwiftUI
import UIKit

struct HistoryView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \GenerationRecord.createdAt, order: .reverse) private var records: [GenerationRecord]
    @State private var confirmDeleteAll = false

    var body: some View {
        NavigationStack {
            Group {
                if records.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        Text("暂无生成记录")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("history.empty")
                } else {
                    List {
                        ForEach(records) { record in
                            NavigationLink {
                                RecordDetailView(record: record)
                            } label: {
                                HistoryRow(record: record)
                            }
                            .accessibilityIdentifier("history.cell")
                        }
                        .onDelete(perform: deleteRecords)
                    }
                    .accessibilityIdentifier("history.list")
                }
            }
            .navigationTitle("历史")
            .toolbar {
                if !records.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("全部删除", role: .destructive) {
                            confirmDeleteAll = true
                        }
                        .accessibilityIdentifier("history.deleteAll")
                    }
                }
            }
            .confirmationDialog("确定删除全部生成记录？此操作不可恢复。", isPresented: $confirmDeleteAll, titleVisibility: .visible) {
                Button("全部删除", role: .destructive) {
                    deleteAll()
                }
                Button("取消", role: .cancel) {}
            }
        }
    }

    private func deleteRecords(at offsets: IndexSet) {
        for index in offsets {
            let record = records[index]
            ResultStorage.delete(record.resultFileName)
            context.delete(record)
        }
        try? context.save()
    }

    private func deleteAll() {
        for record in records {
            ResultStorage.delete(record.resultFileName)
            context.delete(record)
        }
        try? context.save()
    }
}

private struct HistoryRow: View {
    let record: GenerationRecord

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let thumbData = record.thumbData, let image = UIImage(data: thumbData) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: "photo")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 52, height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 4) {
                Text(record.prompt)
                    .font(.subheadline)
                    .lineLimit(2)
                Text("\(record.kindRaw) · \(record.paramsSummary)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(record.statusLabel)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
                        .clipShape(Capsule())
                    if record.statusRaw == "failed", let message = record.errorMessage {
                        Text(message)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var statusColor: Color {
        switch record.statusRaw {
        case "succeeded": return .green
        case "failed": return .red
        default: return .orange
        }
    }
}

struct RecordDetailView: View {
    let record: GenerationRecord
    @State private var saveTitle: String?
    @State private var saveMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(record.prompt)
                    .font(.headline)
                Text("\(record.kindRaw) · \(record.paramsSummary) · \(record.createdAt.formatted())")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if record.statusRaw == "succeeded",
                   let fileName = record.resultFileName,
                   let data = ResultStorage.load(fileName) {
                    if let image = UIImage(data: data) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .accessibilityIdentifier("history.detailImage")
                        Button {
                            Task {
                                if await PhotoSaver.save(image) {
                                    saveTitle = "已保存到相册"
                                    saveMessage = nil
                                } else {
                                    saveTitle = "无法保存到相册"
                                    saveMessage = "请在系统设置中允许访问相册后重试"
                                }
                            }
                        } label: {
                            Label("保存到相册", systemImage: "square.and.arrow.down")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("history.detail.saveButton")
                    } else {
                        Text("结果文件无法解码。")
                            .foregroundStyle(.secondary)
                    }
                } else if record.statusRaw == "failed" {
                    Label(record.errorMessage ?? "生成失败", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                } else {
                    Label("生成中或尚未完成", systemImage: "hourglass")
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
        }
        .navigationTitle("记录详情")
        .alert(
            saveTitle ?? "已保存到相册",
            isPresented: Binding(
                get: { saveTitle != nil },
                set: { if !$0 { saveTitle = nil; saveMessage = nil } }
            )
        ) {
            Button("好", role: .cancel) {}
        } message: {
            if let saveMessage {
                Text(saveMessage)
            }
        }
    }
}
