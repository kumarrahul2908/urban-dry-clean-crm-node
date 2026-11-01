using System.Diagnostics;
using System.Windows;
using Udc.Client;
using Udc.Client.Models;

namespace Udc.App.Views;

public partial class MainWindow : Window
{
    private enum CloseReason { UserQuit, LoggedOut, SettingsRequested }

    private readonly ApiClient _api;
    private CloseReason _closeReason = CloseReason.UserQuit;

    /// <summary>Fired when the user picks File &gt; Log out.</summary>
    public event Action? LoggedOut;

    /// <summary>Fired when the user picks File &gt; Settings...</summary>
    public event Action? SettingsRequested;

    /// <summary>Fired when this window closes for any other reason (Exit menu, Alt+F4, the X
    /// button) - the app should quit.</summary>
    public event Action? UserQuit;

    public MainWindow(ApiClient api, LoginResult login)
    {
        InitializeComponent();
        _api = api;
        Title = $"Urban Dry Clean CRM - {login.User.FullName} ({login.User.RoleName})";
        StatusBarText.Text = $"Signed in as {login.User.Username} - local server http://127.0.0.1:{App.CurrentConfig?.Port ?? 3100}";
        ContentArea.Content = new DashboardView(api);

        Closed += (_, _) =>
        {
            switch (_closeReason)
            {
                case CloseReason.LoggedOut: LoggedOut?.Invoke(); break;
                case CloseReason.SettingsRequested: SettingsRequested?.Invoke(); break;
                default: UserQuit?.Invoke(); break;
            }
        };
    }

    private void SettingsMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _closeReason = CloseReason.SettingsRequested;
        Close();
    }

    private void LogoutMenuItem_Click(object sender, RoutedEventArgs e)
    {
        _ = _api.LogoutAsync(); // best-effort; the session is gone client-side either way
        TokenStore.Clear();
        _closeReason = CloseReason.LoggedOut;
        Close();
    }

    private void OpenLogsMenuItem_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Paths.EnsureAppDataRoot();
            Process.Start(new ProcessStartInfo { FileName = Paths.LogDir, UseShellExecute = true });
        }
        catch (System.ComponentModel.Win32Exception) { /* nothing more we can do here */ }
    }

    private void ExitMenuItem_Click(object sender, RoutedEventArgs e) => Close();

    private void RefreshMenuItem_Click(object sender, RoutedEventArgs e)
    {
        ContentArea.Content = new DashboardView(_api); // simplest reload for Phase 1 (re-fetches on Loaded)
    }

    private void AboutMenuItem_Click(object sender, RoutedEventArgs e)
    {
        var version = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version;
        MessageBox.Show(
            $"Urban Dry Clean CRM\nVersion {version}\n\nLocal server: http://127.0.0.1:{App.CurrentConfig?.Port ?? 3100}",
            "About", MessageBoxButton.OK, MessageBoxImage.Information);
    }
}
