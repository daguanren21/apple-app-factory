import Foundation
import SwiftData

@Model
final class GenerationRecord {
    @Attribute(.unique) var id: UUID
    var kindRaw: String
    var prompt: String
    var paramsSummary: String
    var statusRaw: String
    var errorMessage: String?
    var resultFileName: String?
    var thumbData: Data?
    var createdAt: Date

    init(
        id: UUID = UUID(),
        kindRaw: String,
        prompt: String,
        paramsSummary: String,
        statusRaw: String = "generating",
        errorMessage: String? = nil,
        resultFileName: String? = nil,
        thumbData: Data? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.kindRaw = kindRaw
        self.prompt = prompt
        self.paramsSummary = paramsSummary
        self.statusRaw = statusRaw
        self.errorMessage = errorMessage
        self.resultFileName = resultFileName
        self.thumbData = thumbData
        self.createdAt = createdAt
    }

    var statusLabel: String {
        switch statusRaw {
        case "generating": return "生成中"
        case "succeeded": return "成功"
        case "failed": return "失败"
        default: return statusRaw
        }
    }
}

@MainActor
enum RecordStore {
    static func make(kindRaw: String, prompt: String, paramsSummary: String, context: ModelContext) -> GenerationRecord {
        let record = GenerationRecord(kindRaw: kindRaw, prompt: prompt, paramsSummary: paramsSummary)
        context.insert(record)
        try? context.save()
        return record
    }

    static func finish(
        _ record: GenerationRecord,
        statusRaw: String,
        errorMessage: String? = nil,
        resultFileName: String? = nil,
        thumbData: Data? = nil,
        context: ModelContext
    ) {
        record.statusRaw = statusRaw
        record.errorMessage = errorMessage
        if let resultFileName {
            record.resultFileName = resultFileName
        }
        if let thumbData {
            record.thumbData = thumbData
        }
        try? context.save()
    }
}
