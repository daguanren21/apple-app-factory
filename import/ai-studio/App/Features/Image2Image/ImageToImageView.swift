import Observation
import PhotosUI
import SwiftData
import SwiftUI
import UIKit

@MainActor
@Observable
final class ImageToImageViewModel {
    var prompt = ""
    var phase: Phase = .idle
    var photoItem: PhotosPickerItem? {
        didSet {
            loadSourceImage()
        }
    }
    var sourceImage: UIImage?
    var sourceJPEG: Data?

    private var task: Task<Void, Never>?
    private let provider = PollinationsImageProvider()
    private let settings = AppSettings.shared

    enum Phase: Equatable {
        case idle
        case loading
        case success(UIImage)
        case failed(GenerationError)
    }

    var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var canGenerate: Bool {
        !trimmedPrompt.isEmpty && sourceJPEG != nil && phase != .loading
    }

    private func loadSourceImage() {
        guard let photoItem else { return }
        Task {
            do {
                if let data = try await photoItem.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    sourceImage = image
                    sourceJPEG = ResultStorage.makeJPEG(image)
                }
            } catch {
                sourceImage = nil
                sourceJPEG = nil
            }
        }
    }

    func generate(context: ModelContext) {
        guard canGenerate, let jpeg = sourceJPEG else { return }
        cancel()
        phase = .loading
        let promptText = trimmedPrompt
        let record = RecordStore.make(kindRaw: "img2img", prompt: promptText, paramsSummary: "源图重绘", context: context)

        task = Task {
            do {
                let uploader = ImageUploader(baseURL: settings.uploadBaseURL)
                let sourceURL = try await uploader.upload(data: jpeg, filename: "source.jpg")
                let request = ImageRequest(prompt: promptText, width: 1024, height: 1024, seed: nil, referenceImageURL: sourceURL)
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

struct ImageToImageView: View {
    @Environment(\.modelContext) private var context
    @State private var viewModel = ImageToImageViewModel()
    @State private var saveTitle: String?
    @State private var saveMessage: String?
    @FocusState private var promptFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("源图")
                            .font(.headline)

                        if let sourceImage = viewModel.sourceImage {
                            Image(uiImage: sourceImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxHeight: 220)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .accessibilityIdentifier("img2img.previewImage")
                        }

                        PhotosPicker(selection: $viewModel.photoItem, matching: .images) {
                            Label(
                                viewModel.sourceImage == nil ? "从相册选择源图" : "重新选择源图",
                                systemImage: "photo.on.rectangle.angled"
                            )
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("img2img.pickPhoto")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("提示词")
                            .font(.headline)
                        TextField("描述想要的效果，例如：把它变成水彩画风格", text: $viewModel.prompt, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(3...6)
                            .focused($promptFocused)
                            .accessibilityIdentifier("img2img.prompt")
                    }

                    Button {
                        promptFocused = false
                        viewModel.generate(context: context)
                    } label: {
                        Text("生成图片")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!viewModel.canGenerate)
                    .accessibilityIdentifier("img2img.generate")

                    switch viewModel.phase {
                    case .idle:
                        EmptyView()
                    case .loading:
                        LoadingStateView(message: "正在上传源图并生成，通常需要几十秒…")
                    case .success(let image):
                        ResultImageView(
                            image: image,
                            identifier: "img2img.resultImage",
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
            .navigationTitle("图生图")
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
