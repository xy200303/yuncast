//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	detachedProcess       = 0x00000008
	createNewProcessGroup = 0x00000200
)

func isDarwin() bool { return false }

// 拉起应用：脱离本进程，CLI 退出后应用继续活
func launchDetached(app string, args []string) error {
	cmd := exec.Command(app, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: detachedProcess | createNewProcessGroup,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

var kernel32 = syscall.NewLazyDLL("kernel32.dll")

// Windows 控制台默认 GBK，中文输出会乱码：是真实控制台时切成 UTF-8
// （管道/重定向不碰，免得污染下游字节流）
func setupConsole() {
	stdout := os.Stdout.Fd()
	var mode uint32
	getConsoleMode := kernel32.NewProc("GetConsoleMode")
	r, _, _ := getConsoleMode.Call(stdout, uintptr(unsafe.Pointer(&mode)))
	if r == 0 {
		return
	}
	kernel32.NewProc("SetConsoleOutputCP").Call(65001)
	kernel32.NewProc("SetConsoleCP").Call(65001)
}
