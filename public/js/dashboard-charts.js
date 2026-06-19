// Renders the dashboard charts from data embedded server-side in window.__CHARTS__.
(function () {
  var c = window.__CHARTS__ || {};
  if (!window.Chart) return;

  var ACCENT = "#1C4D8C";
  var PALETTE = ["#16a085", "#2980b9", "#e74c3c", "#8e44ad", "#f39c12", "#c0392b", "#6F1E51", "#5758BB", "#1C4D8C", "#27ae60"];

  // Smooth area chart with a soft gradient fill; today's point highlighted.
  function areaChart(id, labels, data) {
    var el = document.getElementById(id);
    if (!el || !labels || !labels.length) return;
    var ctx = el.getContext("2d");
    var grad = ctx.createLinearGradient(0, 0, 0, el.height || 240);
    grad.addColorStop(0, "rgba(28,77,140,0.28)");
    grad.addColorStop(1, "rgba(28,77,140,0)");
    var last = data.length - 1;

    new window.Chart(el, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          data: data,
          borderColor: ACCENT,
          borderWidth: 2,
          backgroundColor: grad,
          fill: true,
          tension: 0.35,
          pointRadius: data.map(function (_, i) { return i === last ? 4 : 0; }),
          pointHoverRadius: 5,
          pointBackgroundColor: ACCENT,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        }],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#212121",
            padding: 10,
            displayColors: false,
            callbacks: {
              title: function (items) { return items[0].label; },
              label: function (item) { return item.parsed.y + " present"; },
            },
          },
        },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 4, color: "#737373" }, grid: { color: "#f0f0f0" }, border: { display: false } },
          x: { grid: { display: false }, border: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 7, color: "#737373", font: { size: 10 } } },
        },
      },
    });
  }

  function barChart(id, labels, data) {
    var el = document.getElementById(id);
    if (!el || !labels || !labels.length) return;
    new window.Chart(el, {
      type: "bar",
      data: { labels: labels, datasets: [{ data: data, backgroundColor: PALETTE, borderWidth: 0 }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0, color: "#737373" }, grid: { color: "#f0f0f0" }, border: { display: false } },
          x: { grid: { display: false }, border: { display: false }, ticks: { color: "#737373", font: { size: 10 } } },
        },
      },
    });
  }

  if (c.trend) areaChart("trendChart", c.trend.labels, c.trend.data);
  if (c.otBySite) barChart("otChart", c.otBySite.labels, c.otBySite.data);
  if (c.byDesignation) barChart("desigChart", c.byDesignation.labels, c.byDesignation.data);
})();
