(function (global) {
  "use strict";

  // Datas sempre como "YYYY-MM-01" (string) — evita fuso horário mexendo com o dia.
  function monthKey(year, month) {
    return year + "-" + String(month).padStart(2, "0") + "-01";
  }
  function todayKey() {
    var d = new Date();
    return monthKey(d.getFullYear(), d.getMonth() + 1);
  }
  function addMonths(key, n) {
    var parts = key.split("-");
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    var total = (y * 12 + (m - 1)) + n;
    return monthKey(Math.floor(total / 12), (total % 12) + 1);
  }
  // Lista inclusiva de meses entre start e end (ambos "YYYY-MM-01").
  function monthRange(start, end) {
    var out = [start];
    var cur = start;
    var guard = 0;
    while (cur !== end && guard < 2400) {
      cur = addMonths(cur, 1);
      out.push(cur);
      guard++;
    }
    return out;
  }
  function isBefore(a, b) { return a < b; }
  function isAfter(a, b) { return a > b; }

  var MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  function monthLabel(key) {
    var parts = key.split("-");
    return MESES[parseInt(parts[1], 10) - 1];
  }
  function yearOf(key) { return parseInt(key.split("-")[0], 10); }

  /**
   * Monta a "planilha" completa a partir dos dados crus.
   * categories: [{id, name, monthly_estimate, sort_order}]
   * incomeByMonth: { [monthKey]: amount }  -- só meses com lançamento explícito
   * expensesByMonth: { [monthKey]: { [categoryId]: amount } } -- só lançamentos explícitos
   * defaultIncome: number
   * months: [monthKey...] ordenados
   *
   * Retorna { rows: { income:{}, expenses:{[catId]:{}} }, totals: { totalExpenses:{}, balance:{}, cumulative:{} } }
   * onde cada valor é { amount, isDefault }.
   */
  function computeSheet(months, categories, defaultIncome, incomeByMonth, expensesByMonth) {
    var income = {};
    var expenses = {};
    categories.forEach(function (c) { expenses[c.id] = {}; });

    var totalExpenses = {}, balance = {}, cumulative = {};
    var running = 0;

    months.forEach(function (m) {
      var hasIncome = Object.prototype.hasOwnProperty.call(incomeByMonth, m);
      var incAmount = hasIncome ? incomeByMonth[m] : defaultIncome;
      income[m] = { amount: incAmount, isDefault: !hasIncome };

      var monthExpenses = expensesByMonth[m] || {};
      var sum = 0;
      categories.forEach(function (c) {
        var has = Object.prototype.hasOwnProperty.call(monthExpenses, c.id);
        var amount = has ? monthExpenses[c.id] : c.monthly_estimate;
        expenses[c.id][m] = { amount: amount, isDefault: !has };
        sum += amount;
      });

      totalExpenses[m] = sum;
      var bal = incAmount - sum;
      balance[m] = bal;
      running += bal;
      cumulative[m] = running;
    });

    return { income: income, expenses: expenses, totalExpenses: totalExpenses, balance: balance, cumulative: cumulative };
  }

  global.Finance = {
    monthKey: monthKey,
    todayKey: todayKey,
    addMonths: addMonths,
    monthRange: monthRange,
    isBefore: isBefore,
    isAfter: isAfter,
    monthLabel: monthLabel,
    yearOf: yearOf,
    computeSheet: computeSheet
  };
})(window);
