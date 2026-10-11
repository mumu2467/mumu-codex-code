// ============================================================================
//  多 AI 聚合工作台 —— Windows 一键启动器
//
//  为什么要有它：这是个 Node 项目，重启电脑后要么开终端敲 npm run dev:server，
//  要么翻历史命令；对"平时就想直接用"的人来说太麻烦。
//  这个小 exe 只干一件事：把服务拉起来，然后把浏览器打开。关掉窗口时顺手把服务停掉，
//  不留后台进程。
//
//  它**不是**把整个应用打包进来（那是 Electron / SEA 的活儿），
//  只依赖同目录下已有的 node_modules + .env，所以体积很小、改代码也不用重新编译。
//
//  编译方式（Windows 自带 csc，不需要 .NET SDK）：
//    csc /nologo /target:winexe /optimize+ /out:"启动工作台.exe" ^
//        /win32icon:"tools\launcher\app.ico" ^
//        /r:System.Windows.Forms.dll /r:System.Drawing.dll "tools\launcher\Launcher.cs"
//  或直接跑： powershell -ExecutionPolicy Bypass -File tools\launcher\build.ps1
// ============================================================================
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MawLauncher
{
    internal static class Env
    {
        /// <summary>后端默认端口</summary>
        public const int DefaultPort = 8877;

        private static int? _resolvedPort;

        /// <summary>
        /// 实际端口：优先用 .env 里的 PORT=（用户可能改过），否则用默认值。
        /// 不写死的原因：如果 .env 写的是别的端口，启动器会傻等一个永远不响的地址。
        /// </summary>
        public static int Port
        {
            get
            {
                if (_resolvedPort == null) _resolvedPort = ResolvePort();
                return _resolvedPort.Value;
            }
        }

        public static string AppUrl { get { return "http://127.0.0.1:" + Port + "/"; } }
        public static string HealthUrl { get { return "http://127.0.0.1:" + Port + "/api/health"; } }

        /// <summary>扫一遍 .env 找 PORT=xxxx，找不到/不合法就回落到默认端口</summary>
        private static int ResolvePort()
        {
            try
            {
                string file = Path.Combine(ProjectDir, ".env");
                if (!File.Exists(file)) return DefaultPort;
                foreach (string raw in File.ReadAllLines(file))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int equals = line.IndexOf('=');
                    if (equals <= 0) continue;
                    if (line.Substring(0, equals).Trim() != "PORT") continue;
                    int value;
                    string rawValue = line.Substring(equals + 1).Trim().Trim('"');
                    if (int.TryParse(rawValue, out value) && value > 0 && value <= 65535) return value;
                }
            }
            catch { /* 读不到就按默认端口来 */ }
            return DefaultPort;
        }

        /// <summary>exe 所在目录 = 项目根目录（exe 就放在 multi-ai-workbench/ 下）</summary>
        public static string ProjectDir
        {
            get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); }
        }

        public static string LogDir { get { return Path.Combine(ProjectDir, "logs"); } }

        private static readonly object LogLock = new object();

        public static void Log(string line)
        {
            try
            {
                Directory.CreateDirectory(LogDir);
                lock (LogLock)
                {
                    File.AppendAllText(
                        Path.Combine(LogDir, "launcher.log"),
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine,
                        new UTF8Encoding(false));
                }
            }
            catch { /* 记日志失败绝不能影响主流程 */ }
        }

        /// <summary>服务是否已经在跑（1.5s 超时，避免启动器自己被拖住）</summary>
        public static bool ServerUp()
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
                request.Timeout = 1500;
                request.Method = "GET";
                request.Proxy = null; // 别让系统代理插手本机回环
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch { return false; }
        }

        /// <summary>
        /// 没有 .env 就按推荐配置生成一份。
        /// 默认就是 playwright（真实网页版）——这是这个工作台存在的意义；
        /// 想先用不联网的假数据验收交互，把三行改成 mock 即可。
        /// </summary>
        public static void EnsureEnvFile()
        {
            string file = Path.Combine(ProjectDir, ".env");
            if (File.Exists(file)) return;
            string content =
                "# 由启动器自动生成（.env 已在 .gitignore 里，不会入库）\r\n" +
                "HOST=127.0.0.1\r\n" +
                "PORT=" + Port + "\r\n" +
                "LOG_LEVEL=info\r\n" +
                "\r\n" +
                "# mock = 本地假数据（不联网）；playwright = 真实网页版通道\r\n" +
                "ADAPTER_DEEPSEEK=playwright\r\n" +
                "ADAPTER_DOUBAO=playwright\r\n" +
                "ADAPTER_KIMI=playwright\r\n" +
                "\r\n" +
                "# 必须 headed：扫码登录 / 过验证码都靠这扇窗\r\n" +
                "BROWSER_HEADLESS=false\r\n";
            File.WriteAllText(file, content, new UTF8Encoding(false));
            Log("已生成默认 .env（三家走 playwright 通道）");
        }

        /// <summary>把某个端口的监听进程全部干掉（netstat 解析，作为 taskkill 的兜底）</summary>
        public static void KillPortListeners(int port)
        {
            try
            {
                var info = new ProcessStartInfo("cmd.exe", "/c netstat -ano -p tcp | findstr LISTENING | findstr :" + port);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                using (var proc = Process.Start(info))
                {
                    string output = proc.StandardOutput.ReadToEnd();
                    proc.WaitForExit(5000);
                    foreach (string raw in output.Split('\n'))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0) continue;
                        string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length < 5) continue;
                        int pid;
                        if (!int.TryParse(parts[parts.Length - 1], out pid)) continue;
                        if (pid <= 4) continue;
                        Log("兜底结束占用 " + port + " 端口的进程 pid=" + pid);
                        RunHidden("taskkill", "/PID " + pid + " /T /F");
                    }
                }
            }
            catch (Exception ex) { Log("KillPortListeners 失败：" + ex.Message); }
        }

        public static int RunHidden(string file, string args)
        {
            try
            {
                var info = new ProcessStartInfo(file, args);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                using (var proc = Process.Start(info))
                {
                    proc.WaitForExit(15000);
                    return proc.HasExited ? proc.ExitCode : -1;
                }
            }
            catch (Exception ex)
            {
                Log("RunHidden(" + file + ") 失败：" + ex.Message);
                return -1;
            }
        }
    }

    internal sealed class LauncherForm : Form
    {
        private readonly Label _status = new Label();
        private readonly Label _hint = new Label();
        private readonly Button _open = new Button();
        private readonly Button _restart = new Button();
        private readonly Button _logs = new Button();
        private readonly Button _stop = new Button();

        private Process _server;
        private bool _busy;
        // true = 这个后端是本次启动器自己拉起来的；决定关窗时要不要把它停掉
        private bool _startedByUs;

        public LauncherForm()
        {
            Text = "多 AI 聚合工作台 —— 一键启动";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 250);
            BackColor = Color.FromArgb(15, 19, 32);
            ForeColor = Color.FromArgb(226, 232, 240);
            Font = new Font("Microsoft YaHei UI", 9f);

            var title = new Label();
            title.Text = "多 AI 聚合工作台";
            title.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
            title.ForeColor = Color.White;
            title.SetBounds(22, 18, 460, 30);
            Controls.Add(title);

            var subtitle = new Label();
            subtitle.Text = "DeepSeek · 豆包 · Kimi 三窗并发";
            subtitle.ForeColor = Color.FromArgb(148, 163, 184);
            subtitle.SetBounds(24, 50, 460, 20);
            Controls.Add(subtitle);

            _status.Text = "准备中…";
            _status.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
            _status.ForeColor = Color.FromArgb(125, 211, 252);
            _status.SetBounds(24, 88, 470, 24);
            Controls.Add(_status);

            _hint.Text = "";
            _hint.ForeColor = Color.FromArgb(148, 163, 184);
            _hint.SetBounds(24, 114, 470, 40);
            Controls.Add(_hint);

            ConfigureButton(_open, "打开工作台", 24, 172, 128);
            _open.Click += delegate { OpenBrowser(); };
            ConfigureButton(_restart, "重启服务", 160, 172, 110);
            _restart.Click += delegate { RestartServer(); };
            ConfigureButton(_logs, "打开日志", 278, 172, 100);
            _logs.Click += delegate { OpenLogs(); };
            ConfigureButton(_stop, "停止并退出", 386, 172, 110);
            _stop.Click += delegate { Close(); };

            FormClosing += delegate { StopServer(false); };
        }

        private void ConfigureButton(Button button, string text, int x, int y, int width)
        {
            button.Text = text;
            button.SetBounds(x, y, width, 34);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderColor = Color.FromArgb(56, 78, 130);
            button.BackColor = Color.FromArgb(30, 41, 66);
            button.ForeColor = Color.FromArgb(226, 232, 240);
            button.UseVisualStyleBackColor = false;
            Controls.Add(button);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            var worker = new Thread(Bootstrap);
            worker.IsBackground = true;
            worker.Start();
        }

        // ------------------------------------------------------------ 启动流程

        private void Bootstrap()
        {
            SetStatus("正在检查环境…", Color.FromArgb(125, 211, 252));
            SetHint("");

            if (!File.Exists(Path.Combine(Env.ProjectDir, "package.json")))
            {
                Fail("找不到 package.json —— 这个 exe 必须放在 multi-ai-workbench 目录里");
                return;
            }

            // 这个项目跑在 Node.js 上，没装 Node 就什么都做不了，早报比晚报好
            if (Env.RunHidden("cmd.exe", "/c node --version") != 0)
            {
                Fail("没检测到 Node.js。请先装 Node 20 以上版本（https://nodejs.org），装完重开这个 exe");
                Env.Log("node --version 探测失败，判定为未安装 Node.js");
                return;
            }

            Env.EnsureEnvFile();

            if (Env.ServerUp())
            {
                SetStatus("服务已在运行，直接打开页面", Color.FromArgb(134, 239, 172));
                SetHint("（复用已经在跑的后端；关掉本窗口不会把它停掉）");
                OpenBrowser();
                return;
            }

            if (!Directory.Exists(Path.Combine(Env.ProjectDir, "node_modules")))
            {
                SetStatus("首次使用：正在安装依赖…", Color.FromArgb(253, 224, 71));
                SetHint("npm install 需要联网，大约 1~3 分钟，装完会自动继续");
                int code = RunStreaming("npm.cmd", "install");
                if (code != 0)
                {
                    Fail("依赖安装失败（退出码 " + code + "），详情见 logs\\launcher.log");
                    return;
                }
            }

            // 前端页面：npm run build 会把 packages/web 打进 packages/web/dist，
            // 后端一旦发现 dist 存在就直接在同一个端口（8877）上托管它 —— 这就是"单端口可跑"的完整应用。
            // dist 是构建产物、不进仓库，所以换台机器或重新克隆后这里通常是空的，需要先构建一次。
            string webIndex = Path.Combine(Env.ProjectDir, "packages", "web", "dist", "index.html");
            if (!File.Exists(webIndex))
            {
                SetStatus("首次使用：正在构建前端页面…", Color.FromArgb(253, 224, 71));
                SetHint("大约 10~30 秒（Vite 打包），构建完会自动继续，不用管");
                int buildCode = RunStreaming("npm.cmd", "run build");
                if (buildCode != 0)
                {
                    Fail("前端构建失败（退出码 " + buildCode + "），详情见 logs\\launcher.log");
                    return;
                }
            }

            SetStatus("正在启动后端服务…", Color.FromArgb(253, 224, 71));
            SetHint("第一次发消息时会自动弹出三个 AI 的浏览器窗口，登录态是复用上次保存的");
            StartServer();

            for (int second = 1; second <= 120; second++)
            {
                Thread.Sleep(1000);
                if (Env.ServerUp())
                {
                    SetStatus("服务已就绪 ✓", Color.FromArgb(134, 239, 172));
                    SetHint("地址 http://127.0.0.1:" + Env.Port + " —— 页面会自动打开；三个 AI 窗口会在首次发送时弹出");
                    OpenBrowser();
                    return;
                }
                if (second % 5 == 0)
                {
                    SetStatus("正在启动后端服务… " + second + "s", Color.FromArgb(253, 224, 71));
                }
            }
            Fail("启动超时（120s）。看一眼 logs\\launcher.log 里的报错，多半是端口被占或依赖没装好");
        }

        private void StartServer()
        {
            var info = new ProcessStartInfo("cmd.exe");
            info.Arguments = "/c npm.cmd run start --workspace @maw/server";
            info.WorkingDirectory = Env.ProjectDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.RedirectStandardInput = true; // winexe 没有真正的控制台，给子进程一根空管子，比让它去碰无效 stdin 句柄安全
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            // 别让子进程往日志里写 ANSI 颜色码，否则日志文件里全是乱码控制符
            info.EnvironmentVariables["NO_COLOR"] = "1";
            info.EnvironmentVariables["FORCE_COLOR"] = "0";

            _server = new Process();
            _server.StartInfo = info;
            _server.EnableRaisingEvents = true;
            _server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) Env.Log("[server] " + args.Data); };
            _server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) Env.Log("[server!] " + args.Data); };
            _server.Start();
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();
            _startedByUs = true;
            Env.Log("已启动后端 pid=" + _server.Id);
        }

        /// <summary>跑一个会持续输出日志的命令（npm install 用）；返回退出码</summary>
        private int RunStreaming(string file, string args)
        {
            try
            {
                var info = new ProcessStartInfo("cmd.exe", "/c " + file + " " + args);
                info.WorkingDirectory = Env.ProjectDir;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                info.RedirectStandardInput = true; // 同上：winexe 没有真正的控制台，别让子进程去碰无效 stdin 句柄
                info.StandardOutputEncoding = Encoding.UTF8;
                info.StandardErrorEncoding = Encoding.UTF8;
                info.EnvironmentVariables["NO_COLOR"] = "1";
                info.EnvironmentVariables["FORCE_COLOR"] = "0";
                using (var proc = new Process())
                {
                    proc.StartInfo = info;
                    proc.OutputDataReceived += delegate(object sender, DataReceivedEventArgs line) { if (line.Data != null) Env.Log("[npm] " + line.Data); };
                    proc.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs line) { if (line.Data != null) Env.Log("[npm!] " + line.Data); };
                    proc.Start();
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    proc.WaitForExit();
                    return proc.ExitCode;
                }
            }
            catch (Exception ex)
            {
                Env.Log("RunStreaming 异常：" + ex.Message);
                return -1;
            }
        }

        private void RestartServer()
        {
            if (_busy) return;
            _busy = true;
            SetStatus("正在重启服务…", Color.FromArgb(253, 224, 71));
            var worker = new Thread(delegate()
            {
                StopServer(true);
                Thread.Sleep(1200);
                Env.EnsureEnvFile();
                StartServer();
                for (int second = 1; second <= 90; second++)
                {
                    Thread.Sleep(1000);
                    if (Env.ServerUp())
                    {
                        SetStatus("服务已就绪 ✓", Color.FromArgb(134, 239, 172));
                        OpenBrowser();
                        _busy = false;
                        return;
                    }
                }
                _busy = false;
                Fail("重启后 90s 内没起来，看 logs\\launcher.log");
            });
            worker.IsBackground = true;
            worker.Start();
        }

        /// <summary>
        /// 收尾。force=true 表示用户点了"重启服务"，必须先把当前服务停掉；
        /// force=false 表示只是关窗口 —— 这时只有"本次启动器自己拉起来的"服务才停，
        /// 免得把用户在终端里 npm run dev 起的后端一起带走。
        /// </summary>
        private void StopServer(bool force)
        {
            bool ours = _startedByUs;

            try
            {
                if (_server != null && !_server.HasExited && (ours || force))
                {
                    Env.Log("停止后端 pid=" + _server.Id);
                    Env.RunHidden("taskkill", "/PID " + _server.Id + " /T /F");
                    _server.WaitForExit(8000);
                }
            }
            catch (Exception ex) { Env.Log("停止后端失败：" + ex.Message); }
            _server = null;
            _startedByUs = false;

            // 不是我们起的、也不是"重启"：保留它，别误伤
            if (!ours && !force)
            {
                Env.Log("当前后端由外部启动，关窗时予以保留");
                return;
            }

            // 兜底：确保端口彻底释放，避免"关了窗口服务还在跑"
            Thread.Sleep(500);
            if (Env.ServerUp()) Env.KillPortListeners(Env.Port);
        }

        // ------------------------------------------------------------ 界面小工具

        private void SetStatus(string text, Color color)
        {
            RunOnUi(delegate() { _status.Text = text; _status.ForeColor = color; });
        }

        private void SetHint(string text)
        {
            RunOnUi(delegate() { _hint.Text = text; });
        }

        private void Fail(string message)
        {
            SetStatus("出错了", Color.FromArgb(248, 113, 113));
            SetHint(message);
        }

        private void RunOnUi(MethodInvoker action)
        {
            try
            {
                if (IsDisposed) return;
                if (InvokeRequired) BeginInvoke(action);
                else action();
            }
            catch { /* 窗口已经关了就别管了 */ }
        }

        private void OpenBrowser()
        {
            try
            {
                Process.Start(new ProcessStartInfo(Env.AppUrl) { UseShellExecute = true });
                Env.Log("已打开浏览器 " + Env.AppUrl);
            }
            catch (Exception ex)
            {
                SetHint("没能自动打开浏览器，请手动访问 " + Env.AppUrl + "（" + ex.Message + "）");
            }
        }

        private void OpenLogs()
        {
            try
            {
                Directory.CreateDirectory(Env.LogDir);
                Process.Start(new ProcessStartInfo(Env.LogDir) { UseShellExecute = true });
            }
            catch { }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }
}