import { Chat } from "@/components/chat";
export default async function Page({
  params,
}: {
  params: Promise<{ room_id: string }>;
}) {
  const { room_id } = await params;
  return <Chat key={room_id} roomId={room_id} />;
}
