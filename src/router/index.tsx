import { createHashRouter } from 'react-router'
import AIChat from '@/pages/AIChat'
import AutoMessage from '@/pages/AutoMessage'
import AutoPopUp from '@/pages/AutoPopUp'
import AutoReply from '@/pages/AutoReply'
import AutoReplySettings from '@/pages/AutoReply/AutoReplySettings'
import DeviceControl from '@/pages/DeviceControl'
import LeadCenter from '@/pages/LeadCenter'
import LeadScreening from '@/pages/LeadScreening'
import LiveControl from '@/pages/LiveControl'
import OutreachQueue from '@/pages/OutreachQueue'
import RedPacket from '@/pages/RedPacket'
import Settings from '@/pages/SettingsPage'
import App from '../App'

export const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        path: '/',
        element: <DeviceControl />,
      },
      {
        path: '/browser-control',
        element: <LiveControl />,
      },
      {
        path: '/auto-message',
        element: <AutoMessage />,
      },
      {
        path: '/auto-popup',
        element: <AutoPopUp />,
      },
      {
        path: '/settings',
        element: <Settings />,
      },
      {
        path: '/ai-chat',
        element: <AIChat />,
      },
      {
        path: '/lead-center',
        element: <LeadCenter />,
      },
      {
        path: '/lead-screening',
        element: <LeadScreening />,
      },
      {
        path: '/outreach-queue',
        element: <OutreachQueue />,
      },
      {
        path: 'auto-reply',
        element: <AutoReply />,
      },
      {
        path: '/auto-reply/settings',
        element: <AutoReplySettings />,
      },
      {
        path: '/red-packet',
        element: <RedPacket />,
      },
    ],
  },
])
