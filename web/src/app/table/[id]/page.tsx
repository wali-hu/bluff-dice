import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TableRoom } from "@/components/TableRoom";

export const metadata: Metadata = { title: "Table" };

/** /table/<id>: the id is read here; everything else is read from Sepolia in the browser. */
export default async function TablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,30}$/.test(id) || BigInt(id) === 0n) notFound();
  return (
    <div className="container">
      <TableRoom id={id} />
    </div>
  );
}
