import Foundation
import Observation

@MainActor
@Observable
final class AppSettings {
    static let shared = AppSettings()

    private let defaults = UserDefaults.standard
    private let args = ProcessInfo.processInfo.arguments

    private static let defaultUploadBase = "https://uguu.se/upload.php"

    init() {
        
    }

    var videoAPIKey: String {
        get {
            if let override = argValue("-videoKey") {
                return override
            }
            return defaults.string(forKey: "videoAPIKey") ?? ""
        }
        set {
            defaults.set(newValue, forKey: "videoAPIKey")
        }
    }

    var videoModel: String {
        get {
            if let override = argValue("-videoModel") {
                return override
            }
            return defaults.string(forKey: "videoModel") ?? "google/veo-3.1-fast"
        }
        set {
            defaults.set(newValue, forKey: "videoModel")
        }
    }

    var uploadBaseURL: URL {
        let text = argValue("-uploadBaseURL") ?? Self.defaultUploadBase
        return URL(string: text) ?? URL(string: Self.defaultUploadBase)!
    }

    var generationTimeout: TimeInterval {
        if let override = argValue("-generationTimeout"), let value = TimeInterval(override), value > 0 {
            return value
        }
        return 120
    }

    var resetDataOnLaunch: Bool {
        argFlag("-reset-data")
    }

    private func argValue(_ name: String) -> String? {
        guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    private func argFlag(_ name: String) -> Bool {
        args.contains(name)
    }
}
