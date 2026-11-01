using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Udc.Client;
using Udc.Client.Models;

namespace Udc.App.Views;

public partial class DashboardView : UserControl
{
    private readonly ApiClient _api;

    public DashboardView(ApiClient api)
    {
        InitializeComponent();
        _api = api;
        Loaded += async (_, _) => await LoadAsync();
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await LoadAsync();

    private async Task LoadAsync()
    {
        RefreshButton.IsEnabled = false;
        LoadingBar.Visibility = Visibility.Visible;
        ErrorBanner.Visibility = Visibility.Collapsed;
        try
        {
            var summary = await _api.GetDashboardSummaryAsync();
            Render(summary);
        }
        catch (ApiException ex)
        {
            ErrorText.Text = $"Could not load the dashboard: {ex.Message}";
            ErrorBanner.Visibility = Visibility.Visible;
        }
        finally
        {
            LoadingBar.Visibility = Visibility.Collapsed;
            RefreshButton.IsEnabled = true;
        }
    }

    private void Render(DashboardSummary summary)
    {
        DateText.Text = summary.Date;

        CardsPanel.Children.Clear();
        var c = summary.Cards;
        AddCard("Today's Orders", c.TodaysOrders.ToString(CultureInfo.InvariantCulture));
        AddCard("Pending", c.PendingOrders.ToString(CultureInfo.InvariantCulture));
        AddCard("Processing", c.Processing.ToString(CultureInfo.InvariantCulture));
        AddCard("QC Pending", c.QcPending.ToString(CultureInfo.InvariantCulture));
        AddCard("Rework", c.Rework.ToString(CultureInfo.InvariantCulture));
        AddCard("Ready", c.Ready.ToString(CultureInfo.InvariantCulture));
        AddCard("Packed", c.Packed.ToString(CultureInfo.InvariantCulture));
        AddCard("Out for Delivery", c.OutForDelivery.ToString(CultureInfo.InvariantCulture));
        AddCard("Delivered Today", c.DeliveredToday.ToString(CultureInfo.InvariantCulture));
        AddCard("Today's Sales", FormatMoney(c.TodaysSales), accent: true);
        AddCard("Today's Collection", FormatMoney(c.TodaysCollection), accent: true);
        AddCard("Outstanding", FormatMoney(c.Outstanding), accent: true);
        AddCard("Pickup Pending", c.PickupPending.ToString(CultureInfo.InvariantCulture));
        AddCard("Delivery Pending", c.DeliveryPending.ToString(CultureInfo.InvariantCulture));

        SalesPanel.Children.Clear();
        var max = summary.Sales7Days.Count > 0 ? Math.Max(1m, summary.Sales7Days.Max(s => s.Total)) : 1m;
        foreach (var day in summary.Sales7Days)
            AddSalesRow(day.Label, day.Total, max);
        if (summary.Sales7Days.Count == 0)
            SalesPanel.Children.Add(new TextBlock { Text = "No sales recorded in the last 7 days.", Foreground = (Brush)FindResource("MutedBrush") });
    }

    private static string FormatMoney(decimal amount) => "₹" + amount.ToString("N2", CultureInfo.InvariantCulture);

    private void AddCard(string label, string value, bool accent = false)
    {
        var card = new Border
        {
            Width = 200,
            Margin = new Thickness(0, 0, 12, 12),
            Padding = new Thickness(16, 14, 16, 14),
            CornerRadius = new CornerRadius(10),
            Background = Brushes.White,
            BorderBrush = (Brush)FindResource("BorderBrush"),
            BorderThickness = new Thickness(1),
        };
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 11.5,
            Foreground = (Brush)FindResource("MutedBrush"),
            Margin = new Thickness(0, 0, 0, 6),
        });
        stack.Children.Add(new TextBlock
        {
            Text = value,
            FontSize = 22,
            FontWeight = FontWeights.Bold,
            Foreground = accent ? (Brush)FindResource("PrimaryBrush") : (Brush)FindResource("TextBrush"),
        });
        card.Child = stack;
        CardsPanel.Children.Add(card);
    }

    private void AddSalesRow(string label, decimal total, decimal max)
    {
        var row = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(100) });

        var labelText = new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center, FontSize = 12.5, Foreground = (Brush)FindResource("MutedBrush") };
        Grid.SetColumn(labelText, 0);

        var track = new Border { Background = (Brush)FindResource("BgBrush"), CornerRadius = new CornerRadius(5), Height = 16, VerticalAlignment = VerticalAlignment.Center };
        var fillWidthRatio = max > 0 ? (double)(total / max) : 0;
        var fill = new Border
        {
            Background = (Brush)FindResource("AccentBrush"),
            CornerRadius = new CornerRadius(5),
            Height = 16,
            HorizontalAlignment = HorizontalAlignment.Left,
            Width = Math.Max(4, 400 * Math.Clamp(fillWidthRatio, 0, 1)),
        };
        var trackGrid = new Grid();
        trackGrid.Children.Add(track);
        trackGrid.Children.Add(fill);
        Grid.SetColumn(trackGrid, 1);

        var totalText = new TextBlock { Text = FormatMoney(total), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Right, FontSize = 12.5, FontWeight = FontWeights.SemiBold };
        Grid.SetColumn(totalText, 2);

        row.Children.Add(labelText);
        row.Children.Add(trackGrid);
        row.Children.Add(totalText);
        SalesPanel.Children.Add(row);
    }
}
