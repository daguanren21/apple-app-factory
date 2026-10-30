import Foundation

struct VideoRequest {
    var prompt: String
    var durationSeconds: Int
    var model: String
    var apiKey: String?
}

protocol VideoProvider: Sendable {
    func generate(_ request: VideoRequest) async throws -> Data
}

struct PollinationsVideoProvider: VideoProvider {
    var session: URLSession = .shared
    var pollInterval: TimeInterval = 5
    var maxPolls: Int = 60

    private static let pathAllowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

    func generate(_ request: VideoRequest) async throws -> Data {
        guard let key = request.apiKey, !key.isEmpty else {
            throw GenerationError.needsAPIKey
        }
        guard let escaped = request.prompt.addingPercentEncoding(withAllowedCharacters: Self.pathAllowed), !escaped.isEmpty else {
            throw GenerationError.invalidResponse(message: "prompt 编码失败")
        }
        var components = URLComponents(string: "https://gen.pollinations.ai/video/\(escaped)")!
        components.queryItems = [
            URLQueryItem(name: "model", value: request.model),
            URLQueryItem(name: "duration", value: String(request.durationSeconds)),
        ]
        guard let url = components.url else {
            throw GenerationError.invalidResponse(message: "请求地址构造失败")
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("respond-async", forHTTPHeaderField: "Prefer")

        let (data, response) = try await perform(urlRequest)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0

        switch status {
        case 200:
            guard !data.isEmpty else {
                throw GenerationError.invalidResponse(message: "返回内容为空")
            }
            return data
        case 202:
            guard let job = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let statusURLText = job["status_url"] as? String,
                  let statusURL = URL(string: statusURLText) else {
                throw GenerationError.invalidResponse(message: "无法解析异步任务信息")
            }
            return try await pollJob(statusURL: statusURL, key: key)
        case 401:
            throw GenerationError.unauthorized(message: "API Key 无效或被拒绝")
        case 402:
            throw GenerationError.rateLimited(retryAfterSeconds: 60, message: "账户额度不足或被限流")
        case 429, 503:
            let retryAfter = http?.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init) ?? 60
            throw GenerationError.rateLimited(retryAfterSeconds: retryAfter, message: "服务繁忙（HTTP \(status)）")
        default:
            throw GenerationError.invalidResponse(message: "HTTP \(status)")
        }
    }

    private func pollJob(statusURL: URL, key: String) async throws -> Data {
        for _ in 0..<maxPolls {
            try await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
            var pollRequest = URLRequest(url: statusURL)
            pollRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await perform(pollRequest)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200 {
                if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let jobStatus = object["status"] as? String ?? ""
                    if jobStatus == "succeeded" || jobStatus == "completed" {
                        let resultURL = statusURL.absoluteString.contains("result")
                            ? statusURL
                            : statusURL.appendingPathComponent("result")
                        return try await downloadResult(resultURL, key: key)
                    }
                    if jobStatus == "failed" {
                        throw GenerationError.invalidResponse(message: "视频任务生成失败")
                    }
                } else if !data.isEmpty {
                    return data
                }
            } else if status == 401 {
                throw GenerationError.unauthorized(message: "API Key 无效或被拒绝")
            } else if status == 402 {
                throw GenerationError.rateLimited(retryAfterSeconds: 60, message: "账户额度不足或被限流")
            } else if status == 404 {
                throw GenerationError.invalidResponse(message: "任务不存在或已过期")
            } else if status == 409 {
                continue
            } else if status >= 500 {
                continue
            }
        }
        throw GenerationError.invalidResponse(message: "视频任务超时未完成")
    }

    private func downloadResult(_ url: URL, key: String) async throws -> Data {
        var resultRequest = URLRequest(url: url)
        resultRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await perform(resultRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200:
            guard !data.isEmpty else {
                throw GenerationError.invalidResponse(message: "视频结果为空")
            }
            return data
        case 401:
            throw GenerationError.unauthorized(message: "API Key 无效或被拒绝")
        case 409:
            throw GenerationError.invalidResponse(message: "视频结果尚未就绪")
        default:
            throw GenerationError.invalidResponse(message: "下载视频结果失败（HTTP \(status)）")
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch is CancellationError {
            throw GenerationError.cancelled
        } catch let error as URLError {
            throw GenerationError.network(message: error.localizedDescription)
        } catch {
            throw GenerationError.network(message: error.localizedDescription)
        }
    }
}
