import SwiftUI

struct RootTabView: View {
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            TextToImageView()
                .tabItem { Label("文生图", systemImage: "text.bubble") }
                .tag(0)
            ImageToImageView()
                .tabItem { Label("图生图", systemImage: "photo.badge.plus") }
                .tag(1)
            TextToVideoView(onNeedsSettings: { selectedTab = 4 })
                .tabItem { Label("文生视频", systemImage: "video.badge.waveform") }
                .tag(2)
            HistoryView()
                .tabItem { Label("历史", systemImage: "clock") }
                .tag(3)
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(4)
        }
    }
}
