import SwiftData
import SwiftUI

@main
struct AppMain: App {
    let container: ModelContainer

    init() {
        let schema = Schema([GenerationRecord.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
        do {
            let modelContainer = try ModelContainer(for: schema, configurations: [configuration])
            if AppSettings.shared.resetDataOnLaunch {
                let context = ModelContext(modelContainer)
                try context.delete(model: GenerationRecord.self)
                try context.save()
                ResultStorage.clearAll()
            }
            container = modelContainer
        } catch {
            fatalError("无法初始化本地存储: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(AppSettings.shared)
        }
        .modelContainer(container)
    }
}
