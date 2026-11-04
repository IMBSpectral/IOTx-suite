import "@livekit/components-styles";
import "./meet.css";

/**
 * Meet pages have their own layout: the meeting room is full screen (no
 * suite sidebar), like Zoom or Google Meet. The wrapper is fixed over the
 * whole window so it stays full screen whatever wraps it.
 */
export default function MeetLayout({ children }: { children: React.ReactNode }) {
  return children;
}
