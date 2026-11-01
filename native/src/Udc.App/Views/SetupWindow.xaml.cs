using System.Windows;
using System.Windows.Media;
using Udc.Client;

namespace Udc.App.Views;

public partial class SetupWindow : Window
{
    private readonly AppConfig? _existing;
    private bool _savedSuccessfully;

    /// <summary>Fired once the config has been tested, saved, and this window is closing to
    /// continue the boot sequence.</summary>
    public event Action<AppConfig>? Saved;

    /// <summary>Fired if this window closes without saving (Alt+F4, clicking X, ...).</summary>
    public event Action? Cancelled;

    public SetupWindow(AppConfig? existing)
    {
        InitializeComponent();
        _existing = existing;
        Closed += (_, _) => { if (!_savedSuccessfully) Cancelled?.Invoke(); };

        if (existing is not null)
        {
            DbHostBox.Text = existing.DbHost;
            DbPortBox.Text = existing.DbPort.ToString();
            DbNameBox.Text = existing.DbName;
            DbUserBox.Text = existing.DbUser;
            DbPassBox.Password = existing.DbPass;
            AppNameBox.Text = existing.AppName;
            AppSecretKeyBox.Text = existing.AppSecretKey;
            PortBox.Text = existing.Port.ToString();
        }
    }

    private AppConfig ReadForm() => new()
    {
        DbHost = string.IsNullOrWhiteSpace(DbHostBox.Text) ? "127.0.0.1" : DbHostBox.Text.Trim(),
        DbPort = int.TryParse(DbPortBox.Text, out var p) && p > 0 ? p : 3306,
        DbName = DbNameBox.Text.Trim(),
        DbUser = DbUserBox.Text.Trim(),
        DbPass = DbPassBox.Password,
        AppName = string.IsNullOrWhiteSpace(AppNameBox.Text) ? "URBAN DRY CLEAN" : AppNameBox.Text.Trim(),
        AppSecretKey = AppSecretKeyBox.Text.Trim(),
        Port = int.TryParse(PortBox.Text, out var lp) && lp > 0 ? lp : 3100,
    };

    private void SetStatus(string kind, string text)
    {
        StatusBanner.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
        StatusText.Text = text;
        (StatusBanner.Background, StatusText.Foreground) = kind switch
        {
            "ok" => ((Brush)FindResource("OkBgBrush"), (Brush)FindResource("OkBrush")),
            "err" => ((Brush)FindResource("ErrorBgBrush"), (Brush)FindResource("ErrorBrush")),
            _ => ((Brush)new SolidColorBrush(Color.FromRgb(0xEE, 0xF2, 0xF9)), (Brush)FindResource("PrimaryBrush")),
        };
    }

    private void SetBusy(bool busy)
    {
        TestButton.IsEnabled = !busy;
        SaveButton.IsEnabled = !busy;
    }

    private bool ValidateRequired(AppConfig config)
    {
        if (string.IsNullOrWhiteSpace(config.DbName) || string.IsNullOrWhiteSpace(config.DbUser))
        {
            SetStatus("err", "Database name and user are required.");
            return false;
        }
        return true;
    }

    private async void TestButton_Click(object sender, RoutedEventArgs e)
    {
        var config = ReadForm();
        if (!ValidateRequired(config)) return;

        SetBusy(true);
        SetStatus("busy", "Connecting...");
        var result = await DbConnectionTester.TestAsync(config);
        SetBusy(false);

        SetStatus(result.Ok ? "ok" : "err", result.Ok ? "Connected successfully." : $"Could not connect:\n{result.Error}");
    }

    private async void SaveButton_Click(object sender, RoutedEventArgs e)
    {
        var config = ReadForm();
        if (!ValidateRequired(config)) return;

        SetBusy(true);
        SetStatus("busy", "Checking connection...");
        var result = await DbConnectionTester.TestAsync(config);
        if (!result.Ok)
        {
            SetBusy(false);
            SetStatus("err", $"Could not connect, so nothing was saved:\n{result.Error}");
            return;
        }

        var merged = AppConfig.Merge(_existing, config);
        ConfigStore.Save(merged);
        _savedSuccessfully = true;
        Saved?.Invoke(merged);
        Close();
    }
}
