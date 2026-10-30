import Foundation

struct ImageRequest {
    var prompt: String
    var width: Int
    var height: Int
    var seed: Int?
    var referenceImageURL: URL?
}

protocol ImageProvider: Sendable {
    func generate(_ request: ImageRequest) async throws -> Data
}

struct PollinationsImageProvider: ImageProvider {
    var session: URLSession = .shared

    private static let pathAllowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

    func generate(_ request: ImageRequest) async throws -> Data {
        guard let escaped = request.prompt.addingPercentEncoding(withAllowedCharacters: Self.pathAllowed), !escaped.isEmpty else {
            throw GenerationError.invalidResponse(message: "prompt 编码失败")
        }
        guard var components = URLComponents(string: "https://image.pollinations.ai/prompt/\(escaped)") else {
            throw GenerationError.invalidResponse(message: "请求地址构造失败")
        }
        var items = [
            URLQueryItem(name: "width", value: String(request.width)),
            URLQueryItem(name: "height", value: String(request.height)),
            URLQueryItem(name: "nologo", value: "true"),
        ]
        if let seed = request.seed {
            items.append(URLQueryItem(name: "seed", value: String(seed)))
        }
        if let reference = request.referenceImageURL {
            items.append(URLQueryItem(name: "image", value: reference.absoluteString))
        }
        components.queryItems = items
        guard let url = components.url else {
            throw GenerationError.invalidResponse(message: "请求地址构造失败")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(from: url)
        } catch is CancellationError {
            throw GenerationError.cancelled
        } catch let error as URLError {
            throw GenerationError.network(message: error.localizedDescription)
        } catch {
            throw GenerationError.network(message: error.localizedDescription)
        }

        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        switch status {
        case 200:
            guard data.count > 100 else {
                throw GenerationError.invalidResponse(message: "返回内容为空")
            }
            return data
        case 402:
            let info = Self.parseErrorBody(data)
            let retryAfter = http?.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init)
                ?? Self.retrySeconds(from: info.message)
                ?? 45
            throw GenerationError.rateLimited(retryAfterSeconds: retryAfter, message: info.message)
        case 401, 403:
            throw GenerationError.unauthorized(message: "HTTP \(status)")
        default:
            throw GenerationError.invalidResponse(message: "HTTP \(status)")
        }
    }

    private static func parseErrorBody(_ data: Data) -> (code: String, message: String) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = object["error"] as? [String: Any] else {
            return ("", "")
        }
        let code = error["code"] as? String ?? ""
        let message = error["message"] as? String ?? ""
        return (code, message)
    }

    private static func retrySeconds(from message: String) -> Int? {
        let patterns = [
            "Retry after (\\d+)s",
            "retry after (\\d+)",
            "(\\d+) 秒",
        ]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
               let match = regex.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)),
               let range = Range(match.range(at: 1), in: message),
               let seconds = Int(message[range]) {
                return seconds
            }
        }
        return nil
    }
}

struct ImageUploader {
    var baseURL: URL
    var session: URLSession = .shared

    func upload(data: Data, filename: String) async throws -> URL {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()

        func append(_ string: String) {
            if let bytes = string.data(using: .utf8) {
                body.append(bytes)
            }
        }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"files[]\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: image/jpeg\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")

        var request = URLRequest(url: baseURL)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let responseData: Data
        let response: URLResponse
        do {
            (responseData, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw GenerationError.cancelled
        } catch let error as URLError {
            throw GenerationError.uploadFailed(message: error.localizedDescription)
        } catch {
            throw GenerationError.uploadFailed(message: error.localizedDescription)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw GenerationError.uploadFailed(message: "图床返回 HTTP \(status)")
        }
        guard let object = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
              let success = object["success"] as? Bool, success == true,
              let files = object["files"] as? [[String: Any]],
              let urlString = files.first?["url"] as? String,
              let url = URL(string: urlString),
              url.scheme == "https" else {
            throw GenerationError.uploadFailed(message: "图床返回的不是有效链接")
        }
        return url
    }
}
