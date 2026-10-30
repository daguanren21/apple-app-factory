import SwiftUI

struct PrivacyView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("隐私说明")
                    .font(.title2)
                    .bold()
                    .accessibilityIdentifier("privacy.title")

                Text("数据存储")
                    .font(.headline)
                Text("「AI 画室」没有账号系统，不采集统计、不投放广告。所有生成记录（提示词、参数、结果文件与缩略图）只保存在这台设备的本地存储中。你可以在「历史」页删除单条记录或全部记录，删除时会同时清理对应的本地结果文件。")

                Text("会离开设备的数据")
                    .font(.headline)
                Text("生成图片时，你输入的提示词会发送给生成服务 image.pollinations.ai；图生图时，所选源图会先上传到匿名临时图床 uguu.se（链接为临时直链；上传服务可在设置中覆盖），再将公网链接与提示词一起发送给生成服务。文生视频时，提示词与你在设置中填写的 API Key 会发送给 gen.pollinations.ai。除以上必要内容外，应用不会上传任何其他数据。")

                Text("权限")
                    .font(.headline)
                Text("「保存到相册」需要相册写入权限，仅在你主动点击保存时申请。图生图选图使用系统相册选择器，不申请相册读取权限。")

                Text("删除与退出")
                    .font(.headline)
                Text("删除单条记录即删除其本地结果文件；「全部删除」清空全部记录与结果文件。卸载应用会移除应用的全部本地数据。")
            }
            .padding()
        }
        .navigationTitle("隐私说明")
        .accessibilityIdentifier("privacy.body")
    }
}
