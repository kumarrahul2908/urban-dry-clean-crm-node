using System.Windows;

namespace Udc.App.Views;

public partial class SplashWindow : Window
{
    public SplashWindow()
    {
        InitializeComponent();
    }

    public void SetStatus(string text) => StatusText.Text = text;
}
