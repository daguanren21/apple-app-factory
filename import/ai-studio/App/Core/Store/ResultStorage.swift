import Foundation
import UIKit

@MainActor
enum ResultStorage {
    static var resultsDirectory: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Results", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    static func saveImageData(_ data: Data, ext: String = "jpg") -> String {
        let fileName = "\(UUID().uuidString).\(ext)"
        let url = resultsDirectory.appendingPathComponent(fileName)
        try? data.write(to: url, options: .atomic)
        return fileName
    }

    static func load(_ fileName: String) -> Data? {
        let url = resultsDirectory.appendingPathComponent(fileName)
        return try? Data(contentsOf: url)
    }

    static func delete(_ fileName: String?) {
        guard let fileName, !fileName.isEmpty else { return }
        let url = resultsDirectory.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: url)
    }

    static func clearAll() {
        let items = (try? FileManager.default.contentsOfDirectory(at: resultsDirectory, includingPropertiesForKeys: nil)) ?? []
        for item in items {
            try? FileManager.default.removeItem(at: item)
        }
    }

    static func makeThumbnail(_ image: UIImage, maxDimension: CGFloat = 256) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let scale = min(1, maxDimension / longest)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let thumb = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return thumb.jpegData(compressionQuality: 0.8)
    }

    static func makeJPEG(_ image: UIImage, maxDimension: CGFloat = 1024, quality: CGFloat = 0.9) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let scale = min(1, maxDimension / longest)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let scaled = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return scaled.jpegData(compressionQuality: quality)
    }
}
