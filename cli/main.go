// YunCast（小云播客坊）命令行：读 userData/mcp.json 端点文件，POST /cli。
// 零依赖纯标准库，跨平台静态编译（windows/darwin/linux × amd64/arm64）。
// 应用没开时按端点文件的 app/args 拉起应用并轮询等端口（45 秒）。
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const helpText = `用法:
  yuncast tools                         列出工具
  yuncast schema [工具名]                看参数
  yuncast call <工具名> ['<JSON>']       调用工具
  yuncast call <工具名> --json-stdin     参数从标准输入读
  yuncast call <工具名> --json-file <路径>

快捷命令:
  yuncast chat "和主播说一句话"          = call agent_chat
  yuncast tts "文本" --voice <音色id> [--out a.mp3]   = call tts_synthesize
  yuncast status                        = call status

事件流:
  yuncast events [--kinds a,b] [--limit N]     一次性拉近期事件
  yuncast events --follow [--kinds a,b]        实时跟随（SSE，断线自动续传）

应用没开时，这条命令会先启动 YunCast，再把调用送进去。
命令自己读取本机端点文件（userData/mcp.json），不用把令牌贴出来。
加 --json 时，结果是一行 {"ok":true,"text":"..."}。`

type endpoint struct {
	Host    string
	Port    string
	Token   string
	Enabled bool
	App     string
	Args    []string
}

// 与应用保持一致：YUN_CAST_USER_DATA 指向别的目录时（测试/并行实例）读那边的端点文件
func endpointFile() string {
	if dir := os.Getenv("YUN_CAST_USER_DATA"); dir != "" {
		return filepath.Join(dir, "mcp.json")
	}
	if os.Getenv("APPDATA") != "" {
		return filepath.Join(os.Getenv("APPDATA"), "YunCast", "mcp.json")
	}
	home, _ := os.UserHomeDir()
	if isDarwin() {
		return filepath.Join(home, "Library", "Application Support", "YunCast", "mcp.json")
	}
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "YunCast", "mcp.json")
	}
	return filepath.Join(home, ".config", "YunCast", "mcp.json")
}

var urlRe = regexp.MustCompile(`^https?://([^/:]+):(\d+)`)

func readEndpoint() (endpoint, error) {
	var cfg endpoint
	raw, err := os.ReadFile(endpointFile())
	if err != nil {
		return cfg, fmt.Errorf("还没生成端点配置：先打开一次 YunCast。")
	}
	var data struct {
		URL     string   `json:"url"`
		Token   string   `json:"token"`
		Enabled *bool    `json:"enabled"`
		App     string   `json:"app"`
		Args    []string `json:"args"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return cfg, fmt.Errorf("还没生成端点配置：先打开一次 YunCast。")
	}
	match := urlRe.FindStringSubmatch(data.URL)
	if data.URL == "" || data.Token == "" || match == nil {
		return cfg, fmt.Errorf("端点配置不完整：先打开一次 YunCast。")
	}
	cfg.Host, cfg.Port, cfg.Token = match[1], match[2], data.Token
	cfg.Enabled = data.Enabled == nil || *data.Enabled
	cfg.App = data.App
	cfg.Args = data.Args
	return cfg, nil
}

func reachable(cfg endpoint) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(cfg.Host, cfg.Port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func startApp(cfg endpoint) error {
	if cfg.App == "" {
		return fmt.Errorf("找不到 YunCast，先安装并打开一次。")
	}
	return launchDetached(cfg.App, cfg.Args)
}

func connect() (endpoint, error) {
	cfg, err := readEndpoint()
	if err != nil {
		return cfg, err
	}
	if !cfg.Enabled {
		// 先尝试把应用拉起来，方便用户去设置里打开开关
		if cfg.App != "" && !reachable(cfg) {
			_ = startApp(cfg)
		}
		return cfg, fmt.Errorf("请先在 YunCast 设置 → 开放接口 里启用 MCP。")
	}
	if reachable(cfg) {
		return cfg, nil
	}
	if err := startApp(cfg); err != nil {
		return cfg, err
	}
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		next, err := readEndpoint()
		if err != nil {
			continue
		}
		if !next.Enabled {
			return next, fmt.Errorf("请先在 YunCast 设置 → 开放接口 里启用 MCP。")
		}
		if reachable(next) {
			return next, nil
		}
	}
	return cfg, fmt.Errorf("YunCast 没有在规定时间内打开。")
}

type cliResponse struct {
	OK   bool   `json:"ok"`
	Text string `json:"text"`
}

func post(cfg endpoint, body map[string]any) (cliResponse, error) {
	var res cliResponse
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, "http://"+net.JoinHostPort(cfg.Host, cfg.Port)+"/cli", bytes.NewReader(payload))
	if err != nil {
		return res, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+cfg.Token)
	client := &http.Client{Timeout: 130 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return res, err
	}
	defer resp.Body.Close()
	text, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(text, &res); err != nil {
		trimmed := strings.TrimSpace(string(text))
		if trimmed == "" {
			trimmed = fmt.Sprintf("请求失败 %d", resp.StatusCode)
		}
		return res, fmt.Errorf("%s", trimmed)
	}
	return res, nil
}

var wsRe = regexp.MustCompile(`\s+`)

func parseObject(raw string) (map[string]any, error) {
	text := strings.TrimPrefix(strings.TrimSpace(raw), "\uFEFF")
	var args map[string]any
	if err := json.Unmarshal([]byte(text), &args); err != nil || args == nil {
		preview := wsRe.ReplaceAllString(text, " ")
		if len([]rune(preview)) > 200 {
			preview = string([]rune(preview)[:200])
		}
		return nil, fmt.Errorf("参数必须是 JSON 对象，收到: %s", preview)
	}
	return args, nil
}

type parsedArgs struct {
	op       string // tools | schema | call | events
	tool     string
	args     map[string]any
	follow   bool
	kinds    []string
	jsonMode bool
	help     bool
}

func parseArgs(argv []string) (parsedArgs, error) {
	var p parsedArgs
	var rest []string
	jsonStdin := false
	jsonFile := ""
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--json":
			p.jsonMode = true
		case "--json-stdin":
			jsonStdin = true
		case "--json-file":
			if i+1 >= len(argv) || strings.HasPrefix(argv[i+1], "--") {
				return p, fmt.Errorf("缺少 --json-file 的路径")
			}
			i++
			jsonFile = argv[i]
		default:
			rest = append(rest, argv[i])
		}
	}
	if jsonStdin && jsonFile != "" {
		return p, fmt.Errorf("不要同时用 --json-stdin 和 --json-file")
	}
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "--help" || rest[0] == "-h" {
		p.help = true
		return p, nil
	}
	p.args = map[string]any{}

	switch rest[0] {
	case "tools":
		p.op = "tools"
		return p, nil
	case "schema":
		p.op = "schema"
		p.tool = ""
		if len(rest) > 1 {
			p.tool = rest[1]
		}
		return p, nil
	case "chat":
		text := strings.TrimSpace(strings.Join(rest[1:], " "))
		if text == "" {
			return p, fmt.Errorf("用法: yuncast chat \"和主播说一句话\"")
		}
		p.op, p.tool = "call", "agent_chat"
		p.args["text"] = text
		return p, nil
	case "tts":
		voice, out := "", ""
		var words []string
		for i := 1; i < len(rest); i++ {
			switch rest[i] {
			case "--voice":
				if i+1 < len(rest) {
					i++
					voice = rest[i]
				}
			case "--out":
				if i+1 < len(rest) {
					i++
					out = rest[i]
				}
			default:
				words = append(words, rest[i])
			}
		}
		text := strings.TrimSpace(strings.Join(words, " "))
		if text == "" {
			return p, fmt.Errorf("用法: yuncast tts \"文本\" --voice <音色id> [--out a.mp3]")
		}
		if voice == "" {
			return p, fmt.Errorf("缺音色：--voice <音色id>（先 yuncast call tts_voices 查）")
		}
		p.op, p.tool = "call", "tts_synthesize"
		p.args["text"] = text
		p.args["voiceId"] = voice
		if out != "" {
			p.args["outPath"] = out
		}
		return p, nil
	case "status":
		p.op, p.tool = "call", "status"
		return p, nil
	case "events":
		limit := 50
		for i := 1; i < len(rest); i++ {
			switch rest[i] {
			case "--follow":
				p.follow = true
			case "--kinds":
				if i+1 < len(rest) {
					i++
					for _, k := range strings.Split(rest[i], ",") {
						if k = strings.TrimSpace(k); k != "" {
							p.kinds = append(p.kinds, k)
						}
					}
				}
			case "--limit":
				if i+1 < len(rest) {
					i++
					if n, err := strconv.Atoi(rest[i]); err == nil && n > 0 {
						limit = n
					}
				}
			}
		}
		p.op = "events"
		p.args["limit"] = limit
		if len(p.kinds) > 0 {
			p.args["kinds"] = p.kinds
		}
		return p, nil
	case "call":
		if len(rest) < 2 || strings.HasPrefix(rest[1], "--") {
			return p, fmt.Errorf("用法: yuncast call <工具名> ['<JSON>']")
		}
		raw := ""
		if len(rest) > 2 {
			raw = rest[2]
		}
		if raw != "" && (jsonStdin || jsonFile != "") {
			return p, fmt.Errorf("命令行上的 JSON 不要和 --json-stdin、--json-file 一起用")
		}
		if jsonStdin {
			data, _ := io.ReadAll(os.Stdin)
			raw = string(data)
		} else if jsonFile != "" {
			data, err := os.ReadFile(jsonFile)
			if err != nil {
				return p, fmt.Errorf("读不到 --json-file：%v", err)
			}
			raw = string(data)
		}
		if strings.TrimSpace(raw) != "" {
			args, err := parseObject(raw)
			if err != nil {
				return p, err
			}
			p.args = args
		}
		p.op, p.tool = "call", rest[1]
		return p, nil
	default:
		return p, fmt.Errorf("用法: yuncast tools | schema [工具名] | call <工具名> ['<JSON>'] | chat \"...\" | tts \"...\" --voice <id> | status | events [--follow]")
	}
}

func emit(jsonMode bool, res cliResponse) int {
	if jsonMode {
		line, _ := json.Marshal(res)
		fmt.Println(string(line))
	} else if !res.OK {
		fmt.Fprintln(os.Stderr, res.Text)
	} else if res.Text != "" {
		if strings.HasSuffix(res.Text, "\n") {
			fmt.Print(res.Text)
		} else {
			fmt.Println(res.Text)
		}
	}
	if res.OK {
		return 0
	}
	return 1
}

// SSE 跟随事件流：每条事件一行 JSON（含 seq 游标）；断线带 after 自动续传，退避 1s/3s
func followEvents(cfg endpoint, kinds []string) error {
	after := -1
	query := ""
	if len(kinds) > 0 {
		query = "?kinds=" + strings.Join(kinds, ",")
	}
	for {
		url := "http://" + net.JoinHostPort(cfg.Host, cfg.Port) + "/events" + query
		if after >= 0 {
			if query == "" {
				url += "?"
			} else {
				url += "&"
			}
			url += fmt.Sprintf("after=%d", after)
		}
		err := streamEvents(cfg, url, func(data string) {
			var event struct {
				Seq        *int `json:"seq"`
				ResumeFrom *int `json:"resumeFrom"`
			}
			if json.Unmarshal([]byte(data), &event) == nil {
				if event.Seq != nil {
					after = *event.Seq
				} else if event.ResumeFrom != nil {
					after = *event.ResumeFrom // gap 跳段标记
				}
			}
			fmt.Println(data)
		})
		if err != nil {
			time.Sleep(3 * time.Second) // 连接失败：3 秒后重试
		} else {
			time.Sleep(1 * time.Second) // 流正常结束（服务端重启）：1 秒后续传
		}
	}
}

func streamEvents(cfg endpoint, url string, onData func(string)) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+cfg.Token)
	resp, err := (&http.Client{}).Do(req) // 不设超时：长连接
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("事件流请求失败 %d", resp.StatusCode)
	}
	reader := bufio.NewReader(resp.Body)
	var block strings.Builder
	for {
		line, err := reader.ReadString('\n')
		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == "" {
			// 空行 = 一条事件结束
			for _, l := range strings.Split(block.String(), "\n") {
				if strings.HasPrefix(l, "data: ") {
					onData(l[6:]) // 心跳/gap 标记也走这里（gap 在服务端侧跳过，载荷里只有 resumeFrom）
				}
			}
			block.Reset()
		} else {
			block.WriteString(trimmed)
			block.WriteByte('\n')
		}
		if err != nil {
			return nil // 流结束：交由上层续传
		}
	}
}

func run(argv []string) int {
	p, err := parseArgs(argv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	if p.help {
		fmt.Println(helpText)
		return 0
	}
	cfg, err := connect()
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	if p.op == "events" && p.follow {
		if err := followEvents(cfg, p.kinds); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			return 1
		}
		return 0
	}
	body := map[string]any{"op": p.op, "args": p.args}
	if p.op == "events" {
		body["op"] = "call"
		body["tool"] = "events_recent"
	} else if p.tool != "" {
		body["tool"] = p.tool
	}
	res, err := post(cfg, body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "YunCast 没有连上：%v\n", err)
		return 1
	}
	return emit(p.jsonMode, res)
}

func main() {
	setupConsole()
	os.Exit(run(os.Args[1:]))
}
