import XCTest

final class AcceptanceTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    

    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = args
        app.launch()
        return app
    }

    private func attach(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func tapTab(_ app: XCUIApplication, _ title: String) {
        let tab = app.tabBars.buttons[title]
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "找不到 Tab：\(title)")
        tab.tap()
    }

    private func generateText(_ app: XCUIApplication, fieldID: String, prompt: String, buttonID: String) {
        let field = app.textFields[fieldID]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "找不到输入框：\(fieldID)")
        field.tap()
        field.typeText(prompt)
        let button = app.buttons[buttonID]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "找不到按钮：\(buttonID)")
        button.tap()
    }

    private func ensureGenerated(_ app: XCUIApplication, resultID: String, timeout: TimeInterval = 300, shot: String? = nil) {
        let result = app.images[resultID]
        let errorView = app.otherElements["error.view"]
        let retry = app.buttons["error.retryButton"]
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if result.exists {
                if let shot { attach(shot) }
                return
            }
            if errorView.exists, retry.exists {
                if retry.isEnabled {
                    retry.tap()
                    usleep(5_000_000) 
                } else {
                    usleep(1_000_000) 
                }
            } else {
                usleep(1_000_000) 
            }
        }
        attach("timeout_\(shot ?? resultID)")
        XCTFail("生成未在 \(Int(timeout)) 秒内完成：\(resultID)")
    }

    private func pickFirstPhoto(_ app: XCUIApplication) {
        let picker = app.buttons["img2img.pickPhoto"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10), "找不到选图入口")
        picker.tap()

        
        let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 20), "相册中未找到可选照片")
        photo.tap()

        let preview = app.images["img2img.previewImage"]
        XCTAssertTrue(preview.waitForExistence(timeout: 15), "未能从相册选择源图")
    }

    private func historyCellCount(_ app: XCUIApplication) -> Int {
        
        
        app.cells.count
    }

    

    func test01_text2imgSuccessHistoryAndSave() {
        addUIInterruptionMonitor(withDescription: "photo-add-permission") { alert in
            if alert.buttons["Allow"].exists {
                alert.buttons["Allow"].tap()
                return true
            }
            if alert.buttons["允许"].exists {
                alert.buttons["允许"].tap()
                return true
            }
            return false
        }

        let app = launch(["-reset-data"])
        tapTab(app, "文生图")
        generateText(app, fieldID: "txt2img.prompt", prompt: "一只坐在月亮上的红狐狸", buttonID: "txt2img.generate")
        ensureGenerated(app, resultID: "txt2img.resultImage", shot: "01_text2img_result")

        let saveButton = app.buttons["txt2img.resultImage.saveButton"]
        XCTAssertTrue(saveButton.exists, "缺少保存到相册按钮")
        saveButton.tap()
        app.tap()
        XCTAssertTrue(app.alerts["已保存到相册"].waitForExistence(timeout: 10), "保存到相册未确认")

        tapTab(app, "历史")
        XCTAssertTrue(app.staticTexts["一只坐在月亮上的红狐狸"].waitForExistence(timeout: 10), "历史中没有出现生成记录")
        attach("01_text2img_history")
    }

    

    func test02_historyPersistsAcrossRelaunch() {
        var app = launch(["-reset-data"])
        tapTab(app, "文生图")
        generateText(app, fieldID: "txt2img.prompt", prompt: "山间晨雾中的灯塔", buttonID: "txt2img.generate")
        ensureGenerated(app, resultID: "txt2img.resultImage")

        app.terminate()
        app.launchArguments = []
        app.launch()
        tapTab(app, "历史")
        XCTAssertTrue(app.staticTexts["山间晨雾中的灯塔"].waitForExistence(timeout: 15), "重启后历史记录丢失")
        attach("02_history_persist")
    }

    

    func test03_img2imgSuccess() {
        let app = launch(["-reset-data"])
        tapTab(app, "图生图")
        pickFirstPhoto(app)
        generateText(app, fieldID: "img2img.prompt", prompt: "把它变成水彩画风格", buttonID: "img2img.generate")
        ensureGenerated(app, resultID: "img2img.resultImage", shot: "03_img2img_result")

        tapTab(app, "历史")
        XCTAssertTrue(app.staticTexts["把它变成水彩画风格"].waitForExistence(timeout: 10), "图生图记录未进入历史")
        attach("03_img2img_history")
    }

    

    func test04_img2imgUploadFailure() {
        let app = launch(["-reset-data", "-uploadBaseURL", "https://upload.invalid"])
        tapTab(app, "图生图")
        pickFirstPhoto(app)
        generateText(app, fieldID: "img2img.prompt", prompt: "把它变成水彩画风格", buttonID: "img2img.generate")

        let message = app.staticTexts["error.message"]
        XCTAssertTrue(message.waitForExistence(timeout: 60), "未出现上传失败错误")
        XCTAssertTrue(message.label.contains("上传失败"), "错误信息未说明上传失败：\(message.label)")
        XCTAssertTrue(app.buttons["error.retryButton"].exists, "缺少重试入口")
        attach("04_img2img_uploadFailure")
    }

    

    func test05_videoNoKeyHint() {
        let app = launch(["-reset-data", "-videoKey", ""])
        tapTab(app, "文生视频")
        generateText(app, fieldID: "video.prompt", prompt: "纸船在河面上漂流", buttonID: "video.generate")

        let message = app.staticTexts["error.message"]
        XCTAssertTrue(message.waitForExistence(timeout: 15), "未出现需要 API Key 的提示")
        XCTAssertTrue(message.label.contains("API Key"), "提示未说明需要 API Key：\(message.label)")
        XCTAssertTrue(app.buttons["error.retryButton"].exists, "缺少去设置入口")
        attach("05_video_noKey")
    }

    

    func test06_videoInvalidKeyRejected() {
        let app = launch(["-reset-data", "-videoKey", "sk-invalid-local-test"])
        tapTab(app, "文生视频")
        generateText(app, fieldID: "video.prompt", prompt: "纸船在河面上漂流", buttonID: "video.generate")

        let message = app.staticTexts["error.message"]
        XCTAssertTrue(message.waitForExistence(timeout: 120), "未出现服务端拒绝错误")
        XCTAssertTrue(message.label.contains("拒绝") || message.label.contains("无效"), "错误未说明服务端拒绝：\(message.label)")
        attach("06_video_invalidKey")
    }

    

    func test07_rateLimitErrorAndRecovery() {
        let app = launch(["-reset-data"])
        tapTab(app, "文生图")

        
        
        
        let unique = UUID().uuidString.prefix(8)
        let firstPrompt = "星空下的蓝色鲸鱼 \(unique)"
        let secondPrompt = "雪夜里的红色小屋 \(unique)"

        generateText(app, fieldID: "txt2img.prompt", prompt: firstPrompt, buttonID: "txt2img.generate")
        ensureGenerated(app, resultID: "txt2img.resultImage")

        let promptField = app.textFields["txt2img.prompt"]
        promptField.tap()
        let currentValue = promptField.value as? String ?? ""
        promptField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentValue.count + 5))
        promptField.typeText(secondPrompt)
        app.buttons["txt2img.generate"].tap()

        let message = app.staticTexts["error.message"]
        XCTAssertTrue(message.waitForExistence(timeout: 120), "未出现限流错误")
        XCTAssertTrue(message.label.contains("限流"), "错误信息未说明限流：\(message.label)")
        attach("07_rateLimit_error")

        let retry = app.buttons["error.retryButton"]
        let enabled = NSPredicate(format: "isEnabled == true")
        let expectation = XCTNSPredicateExpectation(predicate: enabled, object: retry)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: 90), .completed, "重试按钮未在限流解除后恢复")

        retry.tap()
        ensureGenerated(app, resultID: "txt2img.resultImage", shot: "07_rateLimit_recovered")
    }

    

    func test08_deleteRecordAndPrivacy() {
        let app = launch([])
        tapTab(app, "历史")

        if historyCellCount(app) == 0 {
            tapTab(app, "文生图")
            generateText(app, fieldID: "txt2img.prompt", prompt: "删除测试用的小船", buttonID: "txt2img.generate")
            ensureGenerated(app, resultID: "txt2img.resultImage")
            tapTab(app, "历史")
        }

        let firstCell = app.cells.firstMatch
        XCTAssertTrue(firstCell.waitForExistence(timeout: 10), "历史列表为空，无法验证删除")
        let before = historyCellCount(app)
        XCTAssertGreaterThan(before, 0, "历史列表为空，无法验证删除")

        firstCell.swipeLeft()
        let deleteButton = app.buttons["Delete"].exists ? app.buttons["Delete"] : app.buttons["删除"]
        XCTAssertTrue(deleteButton.waitForExistence(timeout: 10), "未出现删除按钮")
        deleteButton.tap()

        let countDropped = NSPredicate(format: "count == %d", before - 1)
        let expectation = XCTNSPredicateExpectation(predicate: countDropped, object: app.cells)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: 10), .completed, "删除后历史条数未减少")
        attach("08_delete_history")

        tapTab(app, "设置")
        app.buttons["settings.privacyLink"].tap()
        XCTAssertTrue(app.staticTexts["privacy.title"].waitForExistence(timeout: 10), "隐私说明页面不可达")
        attach("08_privacy")
    }
}
