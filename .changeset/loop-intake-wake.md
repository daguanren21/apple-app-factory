---
"apphx": minor
---

drive 循环补全：每次驱动先自动扫 inbox 入队（submit 即进队列，逐条错误上报不打断循环）；wait/done 返回携带完整队列 summary 终局审计（含 needsOwner 计数）；新增无人值守 wake 接线手册（Hermes cron / DimAgent schedule_wakeup / 通用 cron 三种配方与固定 re-entry 指令）。
