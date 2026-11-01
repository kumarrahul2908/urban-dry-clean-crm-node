using System.Windows;
using System.Windows.Input;
using Udc.Client;
using Udc.Client.Models;

namespace Udc.App.Views;

public partial class LoginWindow : Window
{
    private readonly ApiClient _api;
    private bool _loggedIn;

    public event Action<LoginResult>? LoggedIn;

    /// <summary>Fired if this window closes without logging in (Alt+F4, clicking X, ...); there's
    /// nothing useful to show without a session, so the app quits.</summary>
    public event Action? Cancelled;

    public LoginWindow(ApiClient api)
    {
        InitializeComponent();
        _api = api;
        Closed += (_, _) => { if (!_loggedIn) Cancelled?.Invoke(); };
        Loaded += (_, _) => UsernameBox.Focus();
    }

    private void PasswordBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) LoginButton_Click(sender, e);
    }

    private async void LoginButton_Click(object sender, RoutedEventArgs e)
    {
        var username = UsernameBox.Text.Trim();
        var password = PasswordBox.Password;
        if (username.Length == 0 || password.Length == 0)
        {
            ShowError("Username and password are required.");
            return;
        }

        LoginButton.IsEnabled = false;
        ErrorBanner.Visibility = Visibility.Collapsed;
        try
        {
            var result = await _api.LoginAsync(username, password, Environment.MachineName);
            _api.BearerToken = result.Token;
            TokenStore.Save(result.Token);
            _loggedIn = true;
            LoggedIn?.Invoke(result);
            Close();
        }
        catch (ApiException ex)
        {
            ShowError(ex.Message);
        }
        finally
        {
            LoginButton.IsEnabled = true;
        }
    }

    private void ShowError(string message)
    {
        ErrorText.Text = message;
        ErrorBanner.Visibility = Visibility.Visible;
    }
}
