package main
import (
 "context"
 "encoding/json"
 "errors"
 "flag"
 "fmt"
 "os"
 "path/filepath"
 "time"
 "github.com/egoist/mygo"
)
type Counter struct { value int; state string }
func(c *Counter)Change(delta int)(int,error){
 if c.value+delta<0{return c.value,errors.New("negative totals are rejected")}
 next:=c.value+delta
 if c.state!=""{if err:=os.MkdirAll(filepath.Dir(c.state),0700);err!=nil{return c.value,err};if err:=os.WriteFile(c.state,[]byte(fmt.Sprint(next)),0600);err!=nil{return c.value,err}}
 c.value=next;return c.value,nil
}
func(c *Counter)Value()int{return c.value}
func main(){
 acceptance:=flag.Bool("acceptance",false,"run real WKWebView acceptance")
 screenshot:=flag.String("screenshot","","window PNG")
 state:=flag.String("state-file","","durable counter file")
 relaunch:=flag.Bool("relaunch",false,"verify persisted state without adding")
 flag.Parse()
 service:=&Counter{state:*state}
 if *state!=""{data,err:=os.ReadFile(*state);if err==nil{if _,err=fmt.Sscan(string(data),&service.value);err!=nil{panic(err)}}else if !os.IsNotExist(err){panic(err)}}
 mygo.Bind(service)
 type outcome struct{report map[string]any;err error};done:=make(chan outcome,1)
 mygo.App.WhenReady(func(){
  window:=mygo.NewWindow(mygo.WindowOptions{Title:"apphx MyGo Web acceptance",Width:640,Height:440,URL:"/"})
  if !*acceptance{return}
  go func(){
   ctx,cancel:=context.WithTimeout(context.Background(),25*time.Second);defer cancel()
   finish:=func(report map[string]any,err error){done<-outcome{report,err};mygo.App.Quit()}
   ready:=false
   for ctx.Err()==nil{value,err:=window.Page().EvalContext(ctx,"window.smokeReady === true");if err==nil&&value==true{ready=true;break};time.Sleep(25*time.Millisecond)}
   if !ready||!window.IsVisible(){finish(nil,fmt.Errorf("real visible WKWebView did not become ready"));return}
   startup,err:=mygo.EvalAs[map[string]any](window.Page(),"({visibleTotal:Number(document.querySelector('#count').textContent),ready:window.smokeReady === true})")
   if err!=nil{finish(startup,err);return}
   startup["goValue"]=service.Value()
   startup["visible"]=window.IsVisible()
   expected:=0;if *relaunch{expected=3}
   if startup["visibleTotal"]!=float64(expected)||service.Value()!=expected{
    if *screenshot!=""{if png,captureErr:=window.CapturePage();captureErr==nil{if os.MkdirAll(filepath.Dir(*screenshot),0700)==nil{_ = os.WriteFile(*screenshot+".startup.png",png,0600)}}}
    finish(startup,fmt.Errorf("ordinary startup UI/backend mismatch before acceptance actions: %v; want %d",startup,expected));return
   }
 report,err:=mygo.EvalAs[map[string]any](window.Page(),fmt.Sprintf("window.runAcceptance(%t)",*relaunch))
   if err!=nil{finish(report,err);return}
   if report["goValue"]!=float64(3)||report["visibleTotal"]!=float64(3)||report["negativeRejected"]!=true{finish(report,fmt.Errorf("bridge/UI invariants failed: %v",report));return}
   report["startup"]=startup
   report["visible"]=window.IsVisible()
   if *screenshot!=""{png,err:=window.CapturePage();if err!=nil{finish(report,err);return};if err=os.MkdirAll(filepath.Dir(*screenshot),0700);err!=nil{finish(report,err);return};if err=os.WriteFile(*screenshot,png,0600);err!=nil{finish(report,err);return};report["screenshot"]=*screenshot}
   finish(report,nil)
  }()
 })
 if err:=mygo.App.Run();err!=nil{panic(err)}
 if *acceptance{result:=<-done;bytes,_:=json.Marshal(result.report);fmt.Println("APPHX_REAL_MYGO_WEB "+string(bytes));if result.err!=nil{fmt.Fprintln(os.Stderr,result.err);os.Exit(1)}}
}
