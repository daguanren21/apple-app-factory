import Foundation

enum GenerationError: Error, Equatable {
    case needsAPIKey
    case unauthorized(message: String)
    case rateLimited(retryAfterSeconds: Int, message: String)
    case uploadFailed(message: String)
    case network(message: String)
    case invalidResponse(message: String)
    case cancelled

    var title: String {
        "生成失败"
    }

    var message: String {
        switch self {
        case .needsAPIKey:
            return "视频生成需要 API Key：请在「设置」中填写 Pollinations API Key 后再试。"
        case .unauthorized(let m):
            return "服务端拒绝请求：\(m)（请检查 API Key 是否有效）"
        case .rateLimited(let seconds, let m):
            let detail = m.isEmpty ? "请稍后重试" : m
            return "服务限流：\(detail)（约 \(seconds) 秒后可重试）"
        case .uploadFailed(let m):
            return "源图上传失败：\(m)"
        case .network(let m):
            return "网络错误：\(m)"
        case .invalidResponse(let m):
            return "服务返回异常：\(m)"
        case .cancelled:
            return "已取消"
        }
    }

    var retryAfterSeconds: Int? {
        if case .rateLimited(let seconds, _) = self {
            return seconds
        }
        return nil
    }

    var isCancelled: Bool {
        if case .cancelled = self {
            return true
        }
        return false
    }

    var actionTitle: String {
        if case .needsAPIKey = self {
            return "去设置"
        }
        return "重试"
    }
}
