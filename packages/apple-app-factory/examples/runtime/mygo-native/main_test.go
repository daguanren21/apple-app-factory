package main

import (
  "testing"
  "github.com/egoist/mygo/ui"
)
func TestCounterView(t *testing.T) {
  state := &counter{}
  view := ui.NewTester(state.view, 520, 340)
  for _, label := range []string{"Increment", "Increment", "Decrement"} { if err := view.Click(label); err != nil { t.Fatal(err) } }
  if state.value != 1 || !view.HasText("1") { t.Fatalf("counter=%d",state.value) }
  if err := view.Click("Reset"); err != nil { t.Fatal(err) }
  if state.value != 0 { t.Fatalf("reset counter=%d",state.value) }
}
