import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useSettingsModal, type SettingsTab } from '../contexts/SettingsModalContext'

function SettingsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { openSettings } = useSettingsModal()

  useEffect(() => {
    const tabParam = searchParams.get('tab')
    const tab: SettingsTab =
      tabParam === 'audio' ||
      tabParam === 'connections' ||
      tabParam === 'messages' ||
      tabParam === 'downloads' ||
      tabParam === 'info' ||
      tabParam === 'customize'
        ? tabParam
        : 'account'

    openSettings(tab)

    if (window.history.length > 1) {
      navigate(-1)
    } else {
      navigate('/home', { replace: true })
    }
  }, [searchParams, openSettings, navigate])

  return null
}

export default SettingsPage

