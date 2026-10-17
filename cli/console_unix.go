//go:build !windows

package main

import (
	"os/exec"
	"runtime"
	"syscall"
)

func isDarwin() bool { return runtime.GOOS == "darwin" }

// 拉起应用：脱离本进程，CLI 退出后应用继续活
func launchDetached(app string, args []string) error {
	cmd := exec.Command(app, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// unix 终端默认就是 UTF-8，不用动
func setupConsole() {}
