import { NextResponse } from "next/server";
import { getNumberHistory } from "@/lib/queries";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ number: string }> }
) {
  const { number } = await params;
  if (!/^\d{10}$/.test(number)) {
    return NextResponse.json({ error: "Número inválido (10 dígitos)." }, { status: 400 });
  }
  const result = await getNumberHistory(number);
  if (!result) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
  // BigInt (ids) no es serializable a JSON directo -> lo omitimos/convertimos.
  const safe = {
    ...result,
    events: result.events.map((e) => ({
      eventType: e.eventType,
      operatorFrom: e.operatorFrom,
      operatorTo: e.operatorTo,
      source: e.source,
      runLabel: e.runLabel,
      occurredAt: e.occurredAt,
    })),
  };
  return NextResponse.json(safe);
}
