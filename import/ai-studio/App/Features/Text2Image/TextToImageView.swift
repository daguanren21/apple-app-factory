import Observation
import SwiftData
import SwiftUI
import UIKit

@MainActor
@Observable
final class TextToImageViewModel {
    var prompt = ""
    var sizeIndex = 1
    var seedText = ""
    var phase: Phase = .idle

    let sizes = [256, 512, 1024]
    private var task: Task<Void, Never>?
    private let provider = PollinationsImageProvider()

    enum Phase: Equatable {
        case idle
        case loading
        case success(UIImage)
        case failed(GenerationError)
    }

    var currentSize: Int {
        sizes[min(max(sizeIndex, 0), sizes.count - 1)]
    }

    var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var canGenerate: Bool {
        !trimmedPrompt.isEmpty && phase != .loading
    }

    func generate(context: ModelContext) {
        guard canGenerate else { return }
        cancel()
        phase = .loading
        let promptText = trimmedPrompt
        let size = currentSize
        let seed = Int(seedText.trimmingCharacters(in: .whitespacesAndNewlines))
        let params = seed.map { "\(size)×\(size) · seed \($0)" } ?? "\(size)×\(size)"
        let record = RecordStore.make(kindRaw: "txt2img", prompt: promptText, paramsSummary: params, context: context)

        task = Task {
            do {
                let request = ImageRequest(prompt: promptText, width: size, height: size, seed: seed)
                let data = try await provider.generate(request)
                try Task.checkCancellation()
                guard let image = UIImage(data: data) else {
                    throw GenerationError.invalidResponse(message: "图片解码失败")
                }
                let fileName = ResultStorage.saveImageData(data)
                let thumb = ResultStorage.makeThumbnail(image)
                RecordStore.finish(record, statusRaw: "succeeded", resultFileName: fileName, thumbData: thumb, context: context)
                phase = .success(image)
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

struct TextToImageView: View {
    @Environment(\.modelContext) private var context
    @State private var viewModel = TextToImageViewModel()
    @State private var saveTitle: String?
    @State private var saveMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case prompt
        case seed
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("提示词")
                            .font(.headline)
                        TextField("描述你想要的画面，例如：一只坐在月亮上的红狐狸", text: $viewModel.prompt, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(3...6)
                            .focused($focusedField, equals: .prompt)
                            .accessibilityIdentifier("txt2img.prompt")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("尺寸")
                            .font(.headline)
                        Picker("尺寸", selection: $viewModel.sizeIndex) {
                            ForEach(viewModel.sizes.indices, id: \.self) { index in
                                Text("\(viewModel.sizes[index])").tag(index)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("txt2img.size")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("seed（可选，留空则随机）")
                            .font(.headline)
                        TextField("例如 42", text: $viewModel.seedText)
                            .textFieldStyle(.roundedBorder)
                            .keyboardType(.numberPad)
                            .focused($focusedField, equals: .seed)
                            .accessibilityIdentifier("txt2img.seed")
                    }

                    Button {
                        focusedField = nil
                        viewModel.generate(context: context)
                    } label: {
                        Text("生成图片")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!viewModel.canGenerate)
                    .accessibilityIdentifier("txt2img.generate")

                    switch viewModel.phase {
                    case .idle:
                        EmptyView()
                    case .loading:
                        LoadingStateView(message: "正在生成图片，通常需要几秒到一分钟…")
                    case .success(let image):
                        ResultImageView(
                            image: image,
                            identifier: "txt2img.resultImage",
                            onSave: {
                                Task {
                                    if await PhotoSaver.save(image) {
                                        saveTitle = "已保存到相册"
                                        saveMessage = nil
                                    } else {
                                        saveTitle = "无法保存到相册"
                                        saveMessage = "请在系统设置中允许访问相册后重试"
                                    }
                                }
                            },
                            onRegenerate: { viewModel.generate(context: context) }
                        )
                    case .failed(let error):
                        ErrorStateView(error: error) {
                            viewModel.generate(context: context)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("文生图")
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
}
