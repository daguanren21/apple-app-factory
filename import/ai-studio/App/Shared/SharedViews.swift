import SwiftUI

struct LoadingStateView: View {
    var message: String = "生成中…"

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("loading.view")
    }
}

struct ErrorStateView: View {
    let error: GenerationError
    let retry: () -> Void

    @State private var remainingSeconds: Int?
    @State private var countdownTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text(error.message)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("error.message")
            if let remainingSeconds {
                Text("\(remainingSeconds) 秒后可重试")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("error.countdown")
            }
            Button(actionTitle) {
                retry()
            }
            .buttonStyle(.borderedProminent)
            .disabled(remainingSeconds != nil)
            .accessibilityIdentifier("error.retryButton")
        }
        .padding(32)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("error.view")
        .onAppear {
            startCountdownIfNeeded()
        }
        .onDisappear {
            countdownTask?.cancel()
        }
    }

    private var actionTitle: String {
        error.actionTitle
    }

    private func startCountdownIfNeeded() {
        guard let seconds = error.retryAfterSeconds, seconds > 0 else { return }
        remainingSeconds = seconds
        countdownTask?.cancel()
        countdownTask = Task {
            for _ in 0..<seconds {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                remainingSeconds = max(0, (remainingSeconds ?? 1) - 1)
            }
            remainingSeconds = nil
        }
    }
}

struct ResultImageView: View {
    let image: UIImage
    let identifier: String
    let onSave: () -> Void
    let onRegenerate: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxHeight: 420)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier(identifier)
            HStack(spacing: 12) {
                Button {
                    onSave()
                } label: {
                    Label("保存到相册", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("\(identifier).saveButton")

                Button {
                    onRegenerate()
                } label: {
                    Label("重新生成", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
    }
}
