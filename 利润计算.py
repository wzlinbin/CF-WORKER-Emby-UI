import copy
import tkinter as tk
from tkinter import messagebox, ttk

DEFAULT_EXCHANGE_RATIO = 10.0
DEFAULT_MULTIPLIER = 1.0
DEFAULT_MODELS = [
    {"name": "GPT-5.5 (Input)", "official_price_usd": 5.00, "upstream_cost_cny": 0.09},
    {"name": "GPT-5.5 (Output)", "official_price_usd": 30.00, "upstream_cost_cny": 0.09},
    {"name": "GPT-5.4 (Input)", "official_price_usd": 2.50, "upstream_cost_cny": None},
    {"name": "GPT-5.4 (Output)", "official_price_usd": 15.00, "upstream_cost_cny": None},
    {"name": "Claude Opus 4.7 (Input)", "official_price_usd": 5.00, "upstream_cost_cny": None},
    {"name": "Claude Opus 4.7 (Output)", "official_price_usd": 25.00, "upstream_cost_cny": None},
    {"name": "Claude Sonnet 4.6 (Input)", "official_price_usd": 3.00, "upstream_cost_cny": None},
    {"name": "Claude Sonnet 4.6 (Output)", "official_price_usd": 15.00, "upstream_cost_cny": None},
    {"name": "Claude Sonnet 4.5 (Input)", "official_price_usd": 3.00, "upstream_cost_cny": None},
    {"name": "Claude Sonnet 4.5 (Output)", "official_price_usd": 15.00, "upstream_cost_cny": None},
]



def calculate_user_price_cny(official_price_usd, multiplier, exchange_ratio):
    """计算用户每 1M token 的人民币收费。"""
    return round((official_price_usd * multiplier) / exchange_ratio, 4)



def calculate_gross_profit(user_price_cny, upstream_cost_cny):
    """计算每 1M token 的毛利润。"""
    return round(user_price_cny - upstream_cost_cny, 4)



def calculate_gross_margin(user_price_cny, upstream_cost_cny):
    """按销售额口径计算毛利率。"""
    if user_price_cny <= 0:
        return None
    gross_profit = user_price_cny - upstream_cost_cny
    return round((gross_profit / user_price_cny) * 100, 2)



def format_currency(value):
    if value is None:
        return "未配置"
    return f"￥{value:.4f}"



def format_percent(value):
    if value is None:
        return "未配置"
    return f"{value:.2f}%"



def build_pricing_explanation(model_name, official_price_usd, multiplier, exchange_ratio, user_price_cny):
    return (
        f"模型：{model_name}\n\n"
        f"计算公式：\n"
        f"用户收费（元 / 1M token）= 官方价（美元 / 1M token）× 官方价格倍率 ÷ 充值比例\n\n"
        f"本次代入：\n"
        f"{official_price_usd:.4f} × {multiplier:.4f} ÷ {exchange_ratio:.4f} = {user_price_cny:.4f}\n\n"
        f"收费结论：\n"
        f"当前该模型对用户的收费是 {user_price_cny:.4f} 元 / 1M token。\n\n"
        f"对外说明参考：\n"
        f"当前按官方价格的 {multiplier:g}x 计费，且前台充值比例为 1 元人民币兑换 {exchange_ratio:g} 美元额度。"
        f"基于该换算规则，{model_name} 的收费标准为 {user_price_cny:.4f} 元 / 1M token。"
    )



def parse_non_negative_float(value, field_name, allow_blank=False):
    text = value.strip()
    if allow_blank and text == "":
        return None
    try:
        parsed = float(text)
    except ValueError as exc:
        raise ValueError(f"{field_name} 请输入有效数字。") from exc
    if parsed < 0:
        raise ValueError(f"{field_name} 不能小于 0。")
    return parsed


class ProfitCalculatorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("API 成本利润分析工具")
        self.root.geometry("1260x520")
        self.root.minsize(1180, 480)

        self.exchange_ratio_var = tk.StringVar(value=str(DEFAULT_EXCHANGE_RATIO))
        self.multiplier_var = tk.StringVar(value=str(DEFAULT_MULTIPLIER))
        self.config_var = tk.StringVar()
        self.row_widgets = []

        self.models = copy.deepcopy(DEFAULT_MODELS)

        self._build_styles()
        self._build_layout()
        self.reset_defaults()

    def _build_styles(self):
        style = ttk.Style()
        if "clam" in style.theme_names():
            style.theme_use("clam")
        style.configure("Header.TLabel", font=("Microsoft YaHei UI", 10, "bold"))
        style.configure("Result.TLabel", foreground="#0b6bcb")
        style.configure("Muted.TLabel", foreground="#666666")

    def _build_layout(self):
        container = ttk.Frame(self.root, padding=12)
        container.pack(fill="both", expand=True)

        controls = ttk.Frame(container)
        controls.pack(fill="x")

        ttk.Label(controls, text="前台充值比例（1 元换多少美元额度）").grid(row=0, column=0, sticky="w")
        ttk.Entry(controls, textvariable=self.exchange_ratio_var, width=12).grid(row=0, column=1, padx=(8, 16), sticky="w")

        ttk.Label(controls, text="官方价格倍率").grid(row=0, column=2, sticky="w")
        ttk.Entry(controls, textvariable=self.multiplier_var, width=12).grid(row=0, column=3, padx=(8, 16), sticky="w")

        ttk.Button(controls, text="计算", command=self.calculate).grid(row=0, column=4, padx=(0, 8))
        ttk.Button(controls, text="重置默认值", command=self.reset_defaults).grid(row=0, column=5)

        ttk.Label(container, textvariable=self.config_var, style="Muted.TLabel").pack(anchor="w", pady=(8, 10))

        table_container = ttk.Frame(container)
        table_container.pack(fill="both", expand=True)

        headers = [
            "模型名称",
            "官方价 USD/1M",
            "上游成本 CNY/1M",
            "用户收费 CNY/1M",
            "毛利润 CNY/1M",
            "毛利率",
            "收费说明",
        ]
        widths = [28, 14, 16, 16, 16, 10, 10]

        for col, (header, width) in enumerate(zip(headers, widths)):
            ttk.Label(
                table_container,
                text=header,
                width=width,
                anchor="center",
                style="Header.TLabel",
            ).grid(row=0, column=col, padx=4, pady=(0, 8), sticky="ew")

        for index, model in enumerate(self.models, start=1):
            official_var = tk.StringVar(value=f"{model['official_price_usd']:.2f}")
            upstream_var = tk.StringVar(
                value="" if model["upstream_cost_cny"] is None else f"{model['upstream_cost_cny']:.4f}"
            )
            user_price_var = tk.StringVar(value="待计算")
            gross_profit_var = tk.StringVar(value="待计算")
            gross_margin_var = tk.StringVar(value="待计算")

            ttk.Label(table_container, text=model["name"], width=28).grid(row=index, column=0, padx=4, pady=4, sticky="w")
            ttk.Entry(table_container, textvariable=official_var, width=14).grid(row=index, column=1, padx=4, pady=4)
            ttk.Entry(table_container, textvariable=upstream_var, width=16).grid(row=index, column=2, padx=4, pady=4)
            ttk.Label(table_container, textvariable=user_price_var, width=16, style="Result.TLabel").grid(
                row=index, column=3, padx=4, pady=4
            )
            ttk.Label(table_container, textvariable=gross_profit_var, width=16, style="Result.TLabel").grid(
                row=index, column=4, padx=4, pady=4
            )
            ttk.Label(table_container, textvariable=gross_margin_var, width=10, style="Result.TLabel").grid(
                row=index, column=5, padx=4, pady=4
            )
            ttk.Button(
                table_container,
                text="查看说明",
                command=lambda row_index=index - 1: self.show_pricing_explanation(row_index),
            ).grid(row=index, column=6, padx=4, pady=4)

            self.row_widgets.append(
                {
                    "name": model["name"],
                    "official_var": official_var,
                    "upstream_var": upstream_var,
                    "user_price_var": user_price_var,
                    "gross_profit_var": gross_profit_var,
                    "gross_margin_var": gross_margin_var,
                }
            )

        ttk.Label(
            container,
            text="说明：毛利率 = (用户收费 - 上游成本) / 用户收费",
            style="Muted.TLabel",
        ).pack(anchor="w", pady=(10, 0))

    def reset_defaults(self):
        self.exchange_ratio_var.set(str(DEFAULT_EXCHANGE_RATIO))
        self.multiplier_var.set(str(DEFAULT_MULTIPLIER))

        self.models = copy.deepcopy(DEFAULT_MODELS)
        for row, model in zip(self.row_widgets, self.models):
            row["official_var"].set(f"{model['official_price_usd']:.2f}")
            row["upstream_var"].set("" if model["upstream_cost_cny"] is None else f"{model['upstream_cost_cny']:.4f}")
            row["user_price_var"].set("待计算")
            row["gross_profit_var"].set("待计算")
            row["gross_margin_var"].set("待计算")

        self.calculate()

    def _collect_inputs(self):
        exchange_ratio = parse_non_negative_float(self.exchange_ratio_var.get(), "前台充值比例")
        multiplier = parse_non_negative_float(self.multiplier_var.get(), "官方价格倍率")
        if exchange_ratio is None or exchange_ratio <= 0:
            raise ValueError("前台充值比例必须大于 0。")

        rows = []
        for row in self.row_widgets:
            official_price_usd = parse_non_negative_float(row["official_var"].get(), f"{row['name']} 官方价")
            upstream_cost_cny = parse_non_negative_float(
                row["upstream_var"].get(),
                f"{row['name']} 上游成本",
                allow_blank=True,
            )
            rows.append(
                {
                    "name": row["name"],
                    "official_price_usd": official_price_usd,
                    "upstream_cost_cny": upstream_cost_cny,
                }
            )
        return exchange_ratio, multiplier, rows

    def calculate(self):
        try:
            exchange_ratio, multiplier, rows = self._collect_inputs()
        except ValueError as exc:
            messagebox.showerror("输入错误", str(exc), parent=self.root)
            return

        self.models = rows
        self.config_var.set(
            f"当前配置：1 CNY = {exchange_ratio:g} USD 额度 | 官方价格倍率：{multiplier:g}x"
        )

        for row_widgets, model in zip(self.row_widgets, self.models):
            user_price_cny = calculate_user_price_cny(
                model["official_price_usd"],
                multiplier,
                exchange_ratio,
            )
            upstream_cost_cny = model["upstream_cost_cny"]
            gross_profit_cny = None
            gross_margin = None

            if upstream_cost_cny is not None:
                gross_profit_cny = calculate_gross_profit(user_price_cny, upstream_cost_cny)
                gross_margin = calculate_gross_margin(user_price_cny, upstream_cost_cny)

            row_widgets["user_price_var"].set(format_currency(user_price_cny))
            row_widgets["gross_profit_var"].set(format_currency(gross_profit_cny))
            row_widgets["gross_margin_var"].set(format_percent(gross_margin))

    def show_pricing_explanation(self, row_index):
        try:
            exchange_ratio, multiplier, rows = self._collect_inputs()
        except ValueError as exc:
            messagebox.showerror("输入错误", str(exc), parent=self.root)
            return

        model = rows[row_index]
        user_price_cny = calculate_user_price_cny(
            model["official_price_usd"],
            multiplier,
            exchange_ratio,
        )
        content = build_pricing_explanation(
            model["name"],
            model["official_price_usd"],
            multiplier,
            exchange_ratio,
            user_price_cny,
        )

        window = tk.Toplevel(self.root)
        window.title(f"收费说明 - {model['name']}")
        window.geometry("760x360")
        window.transient(self.root)
        window.grab_set()

        frame = ttk.Frame(window, padding=12)
        frame.pack(fill="both", expand=True)

        text = tk.Text(frame, wrap="word", font=("Microsoft YaHei UI", 10))
        text.pack(fill="both", expand=True)
        text.insert("1.0", content)
        text.config(state="disabled")

        button_frame = ttk.Frame(frame)
        button_frame.pack(fill="x", pady=(10, 0))

        ttk.Button(button_frame, text="关闭", command=window.destroy).pack(side="right")



def main():
    for model in DEFAULT_MODELS:
        user_price_cny = calculate_user_price_cny(
            model["official_price_usd"],
            DEFAULT_MULTIPLIER,
            DEFAULT_EXCHANGE_RATIO,
        )
        upstream_cost_cny = model["upstream_cost_cny"]
        gross_profit_cny = None
        gross_margin = None
        if upstream_cost_cny is not None:
            gross_profit_cny = calculate_gross_profit(user_price_cny, upstream_cost_cny)
            gross_margin = calculate_gross_margin(user_price_cny, upstream_cost_cny)

        print(
            f"{model['name']}: 用户收费={format_currency(user_price_cny)} | "
            f"上游成本={format_currency(upstream_cost_cny)} | 毛利润={format_currency(gross_profit_cny)} | "
            f"毛利率={format_percent(gross_margin)}"
        )



def gui_main():
    root = tk.Tk()
    ProfitCalculatorApp(root)
    root.mainloop()


if __name__ == "__main__":
    gui_main()
