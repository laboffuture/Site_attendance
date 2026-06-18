// Renders the dashboard charts from data embedded server-side in window.__CHARTS__.
(function () {
  var c = window.__CHARTS__ || {};
  if (!window.Chart) return;

  var PALETTE = ["#16a085", "#2980b9", "#e74c3c", "#8e44ad", "#f39c12", "#c0392b", "#6F1E51", "#5758BB", "#1C4D8C", "#27ae60"];
  var baseOpts = {
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
  };

  function chart(id, type, labels, data, color) {
    var el = document.getElementById(id);
    if (!el || !labels || !labels.length) return;
    new window.Chart(el, {
      type: type,
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: type === "line" ? "rgba(28,77,140,0.12)" : PALETTE,
          borderColor: color || "#1C4D8C",
          borderWidth: type === "line" ? 2 : 1,
          fill: type === "line",
          tension: 0.3,
        }],
      },
      options: baseOpts,
    });
  }

  if (c.trend) chart("trendChart", "line", c.trend.labels, c.trend.data, "#1C4D8C");
  if (c.otBySite) chart("otChart", "bar", c.otBySite.labels, c.otBySite.data);
  if (c.byDesignation) chart("desigChart", "bar", c.byDesignation.labels, c.byDesignation.data);
})();
