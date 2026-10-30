import SwiftUI

struct SettingsView: View {
    private let settings = AppSettings.shared
    @State private var apiKey = AppSettings.shared.videoAPIKey
    @State private var model = AppSettings.shared.videoModel

    var body: some View {
        NavigationStack {
            Form {
                Section("文生视频服务") {
                    SecureField("Pollinations API Key", text: $apiKey)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("video.keyField")
                        .onChange(of: apiKey) { _, newValue in
                            settings.videoAPIKey = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                        }
                    TextField("模型名称", text: $model)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("video.modelField")
                        .onChange(of: model) { _, newValue in
                            settings.videoModel = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                        }
                    Text("未配置 Key 时视频生成会如实提示，不会伪造结果。Key 仅保存在本机，随请求发送给 Pollinations。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("关于") {
                    NavigationLink {
                        PrivacyView()
                    } label: {
                        Label("隐私说明", systemImage: "hand.raised")
                    }
                    .accessibilityIdentifier("settings.privacyLink")

                    LabeledContent("版本", value: "1.0.1")
                }
            }
            .navigationTitle("设置")
        }
    }
}
