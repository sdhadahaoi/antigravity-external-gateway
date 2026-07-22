using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;

namespace AntigravityGatewayAdmin;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
    }
}

internal sealed class LauncherConfig
{
    public string AdminBaseUrl { get; set; } = "";
    public string UserBaseUrl { get; set; } = "";
    public string AdminKey { get; set; } = "";
    public bool RememberAdminKey { get; set; }
}

internal sealed class MainForm : Form
{
    private readonly TextBox _adminBaseUrl = new();
    private readonly TextBox _userBaseUrl = new();
    private readonly TextBox _adminKey = new();
    private readonly TextBox _friendSlug = new();
    private readonly CheckBox _rememberKey = new();
    private readonly TextBox _status = new();
    private readonly HttpClient _http = new();

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public MainForm()
    {
        Text = "Antigravity Gateway Admin";
        Width = 760;
        Height = 560;
        MinimumSize = new Size(680, 500);
        StartPosition = FormStartPosition.CenterScreen;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            ColumnCount = 1,
            RowCount = 5
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        var title = new Label
        {
            Text = "Antigravity 外接网关桌面启动器",
            AutoSize = true,
            Font = new Font(Font.FontFamily, 15, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 14)
        };
        root.Controls.Add(title);

        root.Controls.Add(BuildSettingsPanel());
        root.Controls.Add(BuildFriendPanel());
        root.Controls.Add(BuildButtonBar());

        _status.Multiline = true;
        _status.ReadOnly = true;
        _status.ScrollBars = ScrollBars.Vertical;
        _status.Dock = DockStyle.Fill;
        _status.Font = new Font("Consolas", 10);
        _status.Margin = new Padding(0, 14, 0, 0);
        root.Controls.Add(_status);

        LoadConfig();
        WriteStatus("就绪。这个工具只连接你的外接网关，不保存或读取上游 OAuth。");
    }

    private Control BuildSettingsPanel()
    {
        var box = new GroupBox
        {
            Text = "网关设置",
            Dock = DockStyle.Top,
            AutoSize = true,
            Padding = new Padding(12)
        };
        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        box.Controls.Add(grid);

        AddRow(grid, "管理员网址", _adminBaseUrl, "https://admin.example.com");
        AddRow(grid, "用户/API 网址", _userBaseUrl, "https://api.example.com");
        _adminKey.UseSystemPasswordChar = true;
        AddRow(grid, "管理员 Key", _adminKey, "GATEWAY_ADMIN_KEY");

        _rememberKey.Text = "在本机记住管理员 Key";
        _rememberKey.AutoSize = true;
        _rememberKey.Margin = new Padding(0, 8, 0, 0);
        grid.Controls.Add(new Label());
        grid.Controls.Add(_rememberKey);
        return box;
    }

    private Control BuildFriendPanel()
    {
        var box = new GroupBox
        {
            Text = "朋友入口",
            Dock = DockStyle.Top,
            AutoSize = true,
            Padding = new Padding(12),
            Margin = new Padding(0, 12, 0, 0)
        };
        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 3
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        box.Controls.Add(grid);

        var label = new Label { Text = "用户短地址", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 8, 8, 0) };
        _friendSlug.Dock = DockStyle.Fill;
        _friendSlug.PlaceholderText = "例如 friend-preview 或 u_xxxxx";
        _friendSlug.Margin = new Padding(0, 5, 8, 0);
        var random = Button("随机生成", (_, _) => _friendSlug.Text = RandomSlug());
        grid.Controls.Add(label, 0, 0);
        grid.Controls.Add(_friendSlug, 1, 0);
        grid.Controls.Add(random, 2, 0);
        return box;
    }

    private Control BuildButtonBar()
    {
        var panel = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            Margin = new Padding(0, 12, 0, 0)
        };
        panel.Controls.Add(Button("保存设置", (_, _) => SaveConfig()));
        panel.Controls.Add(Button("健康检查", async (_, _) => await HealthCheck()));
        panel.Controls.Add(Button("读取概览", async (_, _) => await LoadOverview()));
        panel.Controls.Add(Button("打开管理台", (_, _) => OpenAdminPortal()));
        panel.Controls.Add(Button("打开朋友页", (_, _) => OpenFriendPortal()));
        panel.Controls.Add(Button("复制 API 地址", (_, _) => CopyText(BuildApiBaseUrl())));
        panel.Controls.Add(Button("复制朋友页", (_, _) => CopyText(BuildFriendPortalUrl())));
        return panel;
    }

    private static void AddRow(TableLayoutPanel grid, string text, TextBox input, string placeholder)
    {
        var label = new Label { Text = text, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 8, 8, 0) };
        input.Dock = DockStyle.Fill;
        input.PlaceholderText = placeholder;
        input.Margin = new Padding(0, 5, 0, 0);
        grid.Controls.Add(label);
        grid.Controls.Add(input);
    }

    private static Button Button(string text, EventHandler onClick)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = true,
            Margin = new Padding(0, 0, 8, 8),
            Padding = new Padding(10, 5, 10, 5)
        };
        button.Click += onClick;
        return button;
    }

    private async Task HealthCheck()
    {
        var adminUrl = NormalizeBaseUrl(_adminBaseUrl.Text);
        if (adminUrl.Length == 0)
        {
            WriteStatus("请先填写管理员网址。");
            return;
        }

        try
        {
            using var response = await _http.GetAsync(adminUrl + "/health");
            WriteStatus(response.IsSuccessStatusCode
                ? $"健康检查通过：HTTP {(int)response.StatusCode}"
                : $"健康检查失败：HTTP {(int)response.StatusCode}");
        }
        catch (Exception ex)
        {
            WriteStatus("健康检查失败：" + ex.Message);
        }
    }

    private async Task LoadOverview()
    {
        var adminUrl = NormalizeBaseUrl(_adminBaseUrl.Text);
        var key = _adminKey.Text.Trim();
        if (adminUrl.Length == 0 || key.Length == 0)
        {
            WriteStatus("请填写管理员网址和管理员 Key。");
            return;
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, adminUrl + "/api/admin/overview");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var response = await _http.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                WriteStatus($"读取概览失败：HTTP {(int)response.StatusCode}\r\n{body}");
                return;
            }

            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var channels = root.TryGetProperty("channels", out var c) && c.ValueKind == JsonValueKind.Array ? c.GetArrayLength() : 0;
            var accounts = root.TryGetProperty("accounts", out var a) && a.ValueKind == JsonValueKind.Array ? a.GetArrayLength() : 0;
            var models = root.TryGetProperty("models", out var m) && m.ValueKind == JsonValueKind.Array ? m.GetArrayLength() : 0;
            var upstream = root.TryGetProperty("config", out var config)
                && config.TryGetProperty("upstream_configured", out var up)
                && up.ValueKind == JsonValueKind.True;
            WriteStatus($"连接成功。\r\n通道：{channels}\r\n可用窗口：{accounts}\r\n模型：{models}\r\n上游配置：{(upstream ? "已配置" : "未配置")}");
        }
        catch (Exception ex)
        {
            WriteStatus("读取概览失败：" + ex.Message);
        }
    }

    private void OpenAdminPortal()
    {
        var adminUrl = NormalizeBaseUrl(_adminBaseUrl.Text);
        if (adminUrl.Length == 0)
        {
            WriteStatus("请先填写管理员网址。");
            return;
        }

        var key = _adminKey.Text.Trim();
        if (key.Length > 0)
        {
            Clipboard.SetText(key);
            WriteStatus("已复制管理员 Key 到剪贴板，并打开管理台。");
        }
        OpenUrl(adminUrl + (key.Length > 0 ? "/?key=" + Uri.EscapeDataString(key) : "/"));
    }

    private void OpenFriendPortal()
    {
        var url = BuildFriendPortalUrl();
        if (url.Length == 0) return;
        OpenUrl(url);
    }

    private string BuildFriendPortalUrl()
    {
        var userUrl = NormalizeBaseUrl(_userBaseUrl.Text);
        var slug = _friendSlug.Text.Trim().ToLowerInvariant();
        if (userUrl.Length == 0)
        {
            WriteStatus("请先填写用户/API 网址。");
            return "";
        }
        if (!IsValidSlug(slug))
        {
            WriteStatus("用户短地址必须是 3-64 位小写字母、数字、连字符或下划线，并以字母或数字开头。");
            return "";
        }
        return userUrl + "/u/" + Uri.EscapeDataString(slug) + "/";
    }

    private string BuildApiBaseUrl()
    {
        var portal = BuildFriendPortalUrl();
        return portal.Length == 0 ? "" : portal + "v1";
    }

    private void CopyText(string value)
    {
        if (value.Length == 0) return;
        Clipboard.SetText(value);
        WriteStatus("已复制：\r\n" + value);
    }

    private void LoadConfig()
    {
        try
        {
            if (!File.Exists(ConfigPath)) return;
            var config = JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(ConfigPath)) ?? new LauncherConfig();
            _adminBaseUrl.Text = config.AdminBaseUrl;
            _userBaseUrl.Text = config.UserBaseUrl;
            _rememberKey.Checked = config.RememberAdminKey;
            _adminKey.Text = config.RememberAdminKey ? config.AdminKey : "";
        }
        catch (Exception ex)
        {
            WriteStatus("读取设置失败：" + ex.Message);
        }
    }

    private void SaveConfig()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
            var config = new LauncherConfig
            {
                AdminBaseUrl = NormalizeBaseUrl(_adminBaseUrl.Text),
                UserBaseUrl = NormalizeBaseUrl(_userBaseUrl.Text),
                RememberAdminKey = _rememberKey.Checked,
                AdminKey = _rememberKey.Checked ? _adminKey.Text.Trim() : ""
            };
            File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, JsonOptions));
            WriteStatus(_rememberKey.Checked
                ? "设置已保存。注意：管理员 Key 只保存在本机用户配置目录。"
                : "设置已保存。管理员 Key 未写入本机配置。");
        }
        catch (Exception ex)
        {
            WriteStatus("保存设置失败：" + ex.Message);
        }
    }

    private static string ConfigPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "AntigravityExternalGatewayAdmin",
        "settings.json");

    private static string NormalizeBaseUrl(string value)
    {
        var raw = (value ?? "").Trim().TrimEnd('/');
        return Uri.TryCreate(raw, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            ? uri.GetLeftPart(UriPartial.Authority)
            : "";
    }

    private static bool IsValidSlug(string value)
    {
        if (value.Length is < 3 or > 64) return false;
        if (!char.IsLower(value[0]) && !char.IsDigit(value[0])) return false;
        return value.All(ch => char.IsLower(ch) || char.IsDigit(ch) || ch == '-' || ch == '_');
    }

    private static string RandomSlug()
    {
        const string alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        Span<byte> bytes = stackalloc byte[16];
        System.Security.Cryptography.RandomNumberGenerator.Fill(bytes);
        var chars = new char[18];
        chars[0] = 'u';
        chars[1] = '_';
        for (var i = 0; i < bytes.Length; i++) chars[i + 2] = alphabet[bytes[i] % alphabet.Length];
        return new string(chars);
    }

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private void WriteStatus(string text)
    {
        _status.Text = $"[{DateTime.Now:HH:mm:ss}] {text}";
    }
}
