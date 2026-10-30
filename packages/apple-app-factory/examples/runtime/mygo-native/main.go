package main

import (
    "encoding/json"
    "flag"
    "fmt"
    "os"
    "path/filepath"
    "time"

    "github.com/ebitengine/purego/objc"
    "github.com/egoist/mygo"
    "github.com/egoist/mygo/internal/darwin"
    "github.com/egoist/mygo/ui"
)

type counter struct { value int; stateFile string; failure error; frames int; callbacks int; diagnostic bool }
func (c *counter) change(value int) {
    c.callbacks++
    if c.diagnostic { fmt.Fprintf(os.Stderr,"APPHX_NATIVE_CALLBACK frame=%d callback=%d from=%d to=%d\n",c.frames,c.callbacks,c.value,value) }
    c.value = value
    if c.stateFile != "" { c.failure = os.WriteFile(c.stateFile, []byte(fmt.Sprint(value)), 0600) }
}
func (c *counter) view(ctx *ui.Context) {
    c.frames++
    if c.diagnostic { fmt.Fprintf(os.Stderr,"APPHX_NATIVE_VIEW frame=%d value=%d callbacks=%d\n",c.frames,c.value,c.callbacks) }
    ui.Column(ctx).Fill().Center().Gap(16).Children(func() {
        ui.Text(ctx, "MyGo · apphx desktop acceptance").FontSize(16)
        ui.Textf(ctx, "%d", c.value).FontSize(52).Bold()
        ui.Row(ctx).Gap(12).Children(func() {
            ui.Button(ctx.Key("decrement"), "−").Label("Decrement").OnClick(func() { c.change(c.value - 1) })
            ui.Button(ctx.Key("reset"), "Reset").Label("Reset").OnClick(func() { c.change(0) })
            ui.PrimaryButton(ctx.Key("increment"), "+").Label("Increment").OnClick(func() { c.change(c.value + 1) })
        })
        ui.Text(ctx, "Native macOS window · local ad-hoc build").FontSize(12)
    })
}
func nativePress(handle uintptr, label string) (allowed, accepted bool) {
    children := objc.RegisterName("accessibilityChildren")
    title := objc.RegisterName("accessibilityTitle")
    name := objc.RegisterName("accessibilityLabel")
    utf8 := objc.RegisterName("UTF8String")
    press := objc.RegisterName("accessibilityPerformPress")
    var walk func(objc.ID) bool
    walk = func(node objc.ID) bool {
        text := func(selector objc.SEL) string { value := node.Send(selector); if value == 0 { return "" }; return objc.Send[string](value, utf8) }
        if text(name)+text(title) == label {
            allowed = objc.Send[bool](node,objc.RegisterName("isAccessibilitySelectorAllowed:"),press)
            if allowed { accepted = objc.Send[bool](node,press) }
            return true
        }
        list := node.Send(children)
        for i,n := uint64(0),objc.Send[uint64](list,objc.RegisterName("count")); i<n; i++ { if walk(list.Send(objc.RegisterName("objectAtIndex:"),i)) { return true } }
        return false
    }
    walk(objc.ID(handle).Send(objc.RegisterName("contentView")))
    return
}
func nativeWindowState(handle uintptr) map[string]any {
    window := objc.ID(handle)
    application := objc.ID(objc.GetClass("NSApplication")).Send(objc.RegisterName("sharedApplication"))
    return map[string]any{"occlusionState": objc.Send[uint64](window,objc.RegisterName("occlusionState")), "isVisible": objc.Send[bool](window,objc.RegisterName("isVisible")), "isKeyWindow": objc.Send[bool](window,objc.RegisterName("isKeyWindow")), "isOnActiveSpace": objc.Send[bool](window,objc.RegisterName("isOnActiveSpace")), "applicationActive": objc.Send[bool](application,objc.RegisterName("isActive"))}
}
func nativeReady(state map[string]any) bool {
    return state["isVisible"].(bool) && state["occlusionState"].(uint64)&2 != 0 && state["applicationActive"].(bool) && state["isKeyWindow"].(bool)
}
func main() {
    mode := flag.String("acceptance", "", "first or relaunch actual native-window acceptance")
    stateFile := flag.String("state-file", "", "isolated counter state")
    screenshot := flag.String("screenshot", "", "actual window content PNG")
    flag.Parse()
    c := &counter{stateFile: *stateFile, diagnostic: *mode != ""}
    if bytes, err := os.ReadFile(*stateFile); err == nil { if _, err := fmt.Sscan(string(bytes), &c.value); err != nil { panic(err) } } else if !os.IsNotExist(err) { panic(err) }
    type outcome struct { Report map[string]any; Err error }
    complete := make(chan outcome, 1)
    mygo.App.WhenReady(func() {
        window := mygo.NewWindow(mygo.WindowOptions{Title: "apphx MyGo acceptance", Width: 520, Height: 340, Content: ui.View(c.view)})
        if *mode == "" { return }
        go func() {
            report := map[string]any{"mode": *mode}
            fail := func(err error) {
                mygo.RunOnMain(func() { report["failureFrames"] = c.frames; report["failureCallbacks"] = c.callbacks; report["failureTree"] = darwin.TestAccessibility(window.NativeHandle()); report["failureNativeWindow"] = nativeWindowState(window.NativeHandle()) })
                complete <- outcome{Report: report, Err: err}; mygo.App.Quit()
            }
            deadline := time.Now().Add(20*time.Second)
            ready := false
            focusRequested := false
            for time.Now().Before(deadline) {
                mygo.RunOnMain(func() {
                    found := false
                    for _, node := range darwin.TestAccessibility(window.NativeHandle()) { if node.Role == "AXButton" && node.Label == "Increment" && node.Frame[2] > 0 && node.Frame[3] > 0 { found = true } }
                    // A shown AX tree can belong to an occluded window whose display link does not tick.
                    if found && c.frames > 0 && !focusRequested { report["focusRequestedAfterFrame"] = c.frames; window.Focus(); focusRequested = true }
                    state := nativeWindowState(window.NativeHandle())
                    ready = found && nativeReady(state)
                })
                if ready { break }
                time.Sleep(25*time.Millisecond)
            }
            if !ready || !window.IsVisible() { fail(fmt.Errorf("actual visible native accessibility tree did not become ready")); return }
            report["visible"] = window.IsVisible()
            mygo.RunOnMain(func() { report["readyFrames"] = c.frames; report["readyTree"] = darwin.TestAccessibility(window.NativeHandle()); report["readyNativeWindow"] = nativeWindowState(window.NativeHandle()) })
            width,height := window.ContentSize(); report["width"] = width; report["height"] = height
            initial := 0
            mygo.RunOnMain(func() { initial = c.value })
            report["initial"] = initial
            expected := 0
            labels := []string{"Increment", "Increment", "Decrement"}
            final := 1
            if *mode == "relaunch" { expected = 1; labels = []string{"Reset"}; final = 0 }
            if initial != expected { fail(fmt.Errorf("persisted initial value=%d want=%d",initial,expected)); return }
            wanted := initial
            transitions := []int{}
            for index, label := range labels {
                performed := false
                var actionError error
                mygo.RunOnMain(func() {
                    state := nativeWindowState(window.NativeHandle())
                    if !nativeReady(state) { actionError = fmt.Errorf("native foreground readiness lost before %s: %v",label,state); return }
                    beforeFrames,beforeCallbacks := c.frames,c.callbacks
                    allowed,accepted := nativePress(window.NativeHandle(),label)
                    performed = accepted
                    fmt.Fprintf(os.Stderr,"APPHX_NATIVE_SELECTOR label=%s allowed=%v accepted=%v framesBefore=%d framesAfter=%d callbacksBefore=%d callbacksAfter=%d value=%d\n",label,allowed,accepted,beforeFrames,c.frames,beforeCallbacks,c.callbacks,c.value)
                })
                if actionError != nil { fail(actionError); return }
                if !performed { fail(fmt.Errorf("real accessibility action did not reach %s",label)); return }
                switch label { case "Increment": wanted++; case "Decrement": wanted--; case "Reset": wanted = 0 }
                deadline := time.Now().Add(5*time.Second)
                observed,callbacks := initial,0
                rendered := false
                for time.Now().Before(deadline) {
                    mygo.RunOnMain(func() {
                        observed,callbacks = c.value,c.callbacks
                        rendered = false
                        for _, node := range darwin.TestAccessibility(window.NativeHandle()) { if node.Role == "AXStaticText" && node.Label == fmt.Sprint(wanted) && node.Value == fmt.Sprint(wanted) { rendered = true } }
                    })
                    if observed == wanted && rendered && callbacks == index+1 { break }
                    time.Sleep(15*time.Millisecond)
                }
                if observed != wanted || !rendered || callbacks != index+1 { fail(fmt.Errorf("%s did not transition value=%d want=%d rendered=%v callbacks=%d wantCallbacks=%d",label,observed,wanted,rendered,callbacks,index+1)); return }
                fmt.Fprintf(os.Stderr,"APPHX_NATIVE_TRANSITION label=%s value=%d rendered=%v callbacks=%d\n",label,observed,rendered,callbacks)
                transitions = append(transitions,observed)
            }
            report["transitions"] = transitions
            observed := 0
            var persistenceError error
            mygo.RunOnMain(func() { observed = c.value; persistenceError = c.failure })
            if persistenceError != nil || observed != final { fail(fmt.Errorf("native action state=%d want=%d persistence=%v",observed,final,persistenceError)); return }
            report["actions"] = labels; report["final"] = observed
            mygo.RunOnMain(func() { report["finalNativeWindow"] = nativeWindowState(window.NativeHandle()); report["finalFrames"] = c.frames; report["finalCallbacks"] = c.callbacks })
            if !nativeReady(report["finalNativeWindow"].(map[string]any)) { fail(fmt.Errorf("native foreground readiness lost after actions")); return }
            if *screenshot != "" {
                bytes,err := window.CapturePage()
                if err != nil { fail(err); return }
                captureReady := false
                mygo.RunOnMain(func() { captureReady = nativeReady(nativeWindowState(window.NativeHandle())) })
                if !captureReady { fail(fmt.Errorf("native foreground readiness lost during screenshot capture")); return }
                if err := os.MkdirAll(filepath.Dir(*screenshot),0700); err != nil { fail(err); return }
                if err := os.WriteFile(*screenshot,bytes,0600); err != nil { fail(err); return }
                report["screenshot"] = *screenshot
            }
            complete <- outcome{Report: report}
            mygo.App.Quit()
        }()
    })
    if err := mygo.App.Run(); err != nil { panic(err) }
    if *mode != "" {
        result := <-complete
        bytes,_ := json.Marshal(result.Report)
        fmt.Println("APPHX_REAL_MYGO_UI "+string(bytes))
        if result.Err != nil { fmt.Fprintln(os.Stderr,result.Err); os.Exit(1) }
    }
}
