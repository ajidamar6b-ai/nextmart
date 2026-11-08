import crypto from "node:crypto";

const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");

export async function getPriceList() {
  const { IAK_USERNAME, IAK_API_KEY, IAK_BASE_URL } = process.env;
  if (!IAK_USERNAME || !IAK_API_KEY) throw new Error("IAK credentials belum diatur di Environment Render.");
  const sign = md5(IAK_USERNAME + IAK_API_KEY + "pl");
  const response = await fetch(`${IAK_BASE_URL || "https://prepaid.iak.dev"}/api/pricelist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: IAK_USERNAME, sign, status: "all" })
  });
  if (!response.ok) throw new Error(`IAK pricelist HTTP ${response.status}`);
  return response.json();
}

export async function submitTopup({ ref_id, customer_id, product_code }) {
  const { IAK_USERNAME, IAK_API_KEY, IAK_BASE_URL } = process.env;
  const sign = md5(IAK_USERNAME + IAK_API_KEY + ref_id);
  const response = await fetch(`${IAK_BASE_URL || "https://prepaid.iak.dev"}/api/top-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: IAK_USERNAME, ref_id, customer_id, product_code, sign })
  });
  if (!response.ok) throw new Error(`IAK top-up HTTP ${response.status}`);
  return response.json();
}
