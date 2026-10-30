import AVKit
import Observation
import SwiftData
import SwiftUI

@MainActor
@Observable
final class TextToVideoViewModel {
    var prompt = ""
    var durationIndex = 0
    var phase: Phase = .idle

    let durations = [3, 5, 10]
    private var task: Task<Void, Never>?
    private let provider = PollinationsVideoProvider()
    private let settings = AppSettings.shared

    enum Phase: Equatable {
        case idle
        case loading
        case success(URL)
        case failed(GenerationError)
    }

    var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var currentDuration: Int {
        durations[min(max(durationIndex, 0), durations.count - 1)]
    }

    var canGenerate: Bool {
        !trimmedPrompt.isEmpty && phase != .loading
    }

    func generate(context: ModelContext, onNeedsSettings: @escaping () -> Void) {
        guard canGenerate else { return }
        cancel()
        let key = settings.videoAPIKey
        if key.isEmpty {
            phase = .failed(.needsAPIKey)
            return
        }
        phase = .loading
        let promptText = trimmedPrompt
        let duration = currentDuration
        let record = RecordStore.make(
            kindRaw: "txt2video",
            prompt: promptText,
            paramsSummary: "\(duration) 秒 · \(settings.videoModel)",
            context: context
        )

        task = Task {
            do {
                let request = VideoRequest(
                    prompt: promptText,
                    durationSeconds: duration,
                    model: settings.videoModel,
                    apiKey: key
                )
                let data = try await provider.generate(request)
                try Task.checkCancellation()
                guard data.count > 100 else {
                    throw GenerationError.invalidResponse(message: "视频返回内容为空")
                }
                let fileName = ResultStorage.saveImageData(data, ext: "mp4")
                RecordStore.finish(record, statusRaw: "succeeded", resultFileName: fileName, context: context)
                let fileURL = ResultStorage.resultsDirectory.appendingPathComponent(fileName)
                phase = .success(fileURL)
            } catch let error as GenerationError {
                RecordStore.finish(record, statusRaw: "failed", errorMessage: error.message, context: context)
                phase = .failed(error)
            } catch is CancellationError {
                RecordStore.finish(record, statusRaw: "failed", errorMessage: "已取消", context: context)
                phase = .idle
            } catch {
                RecordStore.finish(record, statusRaw: "failed", errorMessage: error.localizedDescription, context: context)
                phase = .failed(GenerationError.invalidResponse(message: error.localizedDescription))
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}

struct TextToVideoView: View {
    @Environment(\.modelContext) private var context
    @State private var viewModel = TextToVideoViewModel()
    @FocusState private var promptFocused: Bool
    var onNeedsSettings: () -> Void = {}

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("提示词")
                            .font(.headline)
                        TextField("描述想要的短视频，例如：纸船在河面上漂流", text: $viewModel.prompt, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(3...6)
                            .focused($promptFocused)
                            .accessibilityIdentifier("video.prompt")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("时长")
                            .font(.headline)
                        Picker("时长", selection: $viewModel.durationIndex) {
                            ForEach(viewModel.durations.indices, id: \.self) { index in
                                Text("\(viewModel.durations[index]) 秒").tag(index)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("video.duration")
                    }

                    Text("视频生成通过 Pollinations 服务完成，需要 API Key（在「设置」中配置）。未配置时应用会如实提示，不会伪造结果。")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Button {
                        promptFocused = false
                        viewModel.generate(context: context, onNeedsSettings: onNeedsSettings)
                    } label: {
                        Text("生成视频")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!viewModel.canGenerate)
                    .accessibilityIdentifier("video.generate")

                    switch viewModel.phase {
                    case .idle:
                        EmptyView()
                    case .loading:
                        LoadingStateView(message: "视频生成可能需要几分钟，请保持应用在前台…")
                    case .success(let url):
                        VStack(spacing: 12) {
                            VideoPlayer(player: AVPlayer(url: url))
                                .frame(height: 300)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .accessibilityIdentifier("video.resultPlayer")
                            Text("视频已保存到本地历史。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    case .failed(let error):
                        ErrorStateView(error: error) {
                            if case .needsAPIKey = error {
                                onNeedsSettings()
                            } else {
                                viewModel.generate(context: context, onNeedsSettings: onNeedsSettings)
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("文生视频")
        }
    }
}
