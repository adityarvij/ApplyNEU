import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { expireSession } from '../../lib/session'
import { api } from '../../lib/api'
import { suppressErrorRedirect, releaseErrorRedirect } from '../../lib/fetchErrorControl'
import './onboarding.css'

const SCREEN_SUPPRESSOR = 'onboarding-screen'

type UploadStage = 'presigning' | 'uploading' | 'saving' | 'saved' | 'failed'

const UPLOAD_STAGE_LABELS: Partial<Record<UploadStage, string>> = {
  presigning: 'preparing upload...',
  uploading: 'uploading...',
  saving: 'reading your resume...',
  saved: 'uploaded',
}

const isPlausibleGradYear = (year: number) => Number.isInteger(year) && year >= 2000 && year <= 2040

interface OnboardingProps {
  onComplete: () => void
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [uploadStage, setUploadStage] = useState<UploadStage | null>(null)
  const uploadController = useRef<AbortController | null>(null)
  const uploadedResumeId = useRef<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [gradYear, setGradYear] = useState('')
  const [interests, setInterests] = useState<string[]>([])
  const [selectedInterests, setSelectedInterests] = useState<string[]>([])
  const jobTypes = ['Co-op', 'Full Time / Part Time', 'Internship']
  const [selectedJobTypes, setSelectedJobTypes] = useState<string[]>([])

  // Onboarding reports its own failures inline; a dead backend should not bounce a
  // half-finished signup to the full-page /error screen.
  useEffect(() => {
    suppressErrorRedirect(SCREEN_SUPPRESSOR)
    return () => releaseErrorRedirect(SCREEN_SUPPRESSOR)
  }, [])

  useEffect(() => () => uploadController.current?.abort(), [])

  useEffect(() => {
    const prefillDetails = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      const metadata = user?.user_metadata ?? {}
      // OAuth providers hand back a single display name, email signup sets the parts.
      const [derivedFirst = '', ...derivedRest] = (metadata.full_name ?? metadata.name ?? '')
        .toString()
        .trim()
        .split(/\s+/)

      let profile: Record<string, unknown> = {}
      try {
        const response = await api.get('/me')
        if (response.ok) profile = await response.json()
      } catch (error) {
        console.error('Error fetching profile:', error)
      }

      // The signup trigger writes blanks for providers that supply no name, so treat
      // empty strings as missing rather than as a value to prefill with.
      const firstPresent = (...values: unknown[]) =>
        values.map((value) => (value ?? '').toString().trim()).find((value) => value !== '') ?? ''

      setFirstName(firstPresent(profile.first_name, metadata.first_name, derivedFirst))
      setLastName(firstPresent(profile.last_name, metadata.last_name, derivedRest.join(' ')))
      // The signup trigger stores 0 when a provider gives no graduation year; that
      // placeholder must not reach the field as a prefilled value.
      const gradYearCandidate = firstPresent(profile.grad_year, metadata.graduation_year)
      const gradYearNumber = Number.parseInt(gradYearCandidate, 10)
      setGradYear(isPlausibleGradYear(gradYearNumber) ? gradYearCandidate : '')
    }

    void prefillDetails()
  }, [])

  const saveDetails = async (): Promise<string | null> => {
    const year = Number.parseInt(gradYear, 10)
    if (!isPlausibleGradYear(year)) {
      return 'please enter a valid graduation year.'
    }

    try {
      const response = await api.put('/me', {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        grad_year: year,
      })
      return response.ok ? null : 'could not save your details. please try again.'
    } catch (error) {
      console.error('Error saving details:', error)
      return 'could not save your details. please try again.'
    }
  }

  useEffect(() => {
    const fetchInterests = async () => {
      try {
        const response = await api.get('/interests')
        if (response.ok) setInterests(await response.json())
      } catch (error) {
        console.error('Error fetching interests:', error)
      }
    }

    void fetchInterests()
  }, [])

  const toggleInterest = (interest: string) => {
    setSelectedInterests(prev => 
      prev.includes(interest) 
        ? prev.filter(i => i !== interest)
        : [...prev, interest]
    )
  }

  const toggleJobType = (type: string) => {
    setSelectedJobTypes(prev =>
      prev.includes(type)
        ? prev.filter(t => t !== type)
        : [...prev, type]
    )
  }

  const saveInterests = async (): Promise<boolean> => {
    try {
      const response = await api.put('/me/preferences/interests', { interests: selectedInterests })
      return response.ok
    } catch (error) {
      console.error('Error saving interests:', error)
      return false
    }
  }

  const updateJobTypes = async (): Promise<boolean> => {
    try {
      const response = await api.put('/me/preferences/job-types', {
        job_types: selectedJobTypes
      })
      return response.ok
    } catch (error) {
      console.error('Error updating job types:', error)
      return false
    }
  }

  const handleComplete = async () => {
    setLoading(true)

    const { data: { user } } = await supabase.auth.getUser()

    if (user) {
      await supabase.auth.updateUser({
        data: {
          ...user.user_metadata,
          onboarding_completed: true
        }
      })
    }

    setLoading(false)
    onComplete()
  }

  const nextStep = async () => {
    setStepError(null)

    if (step === 1) {
      setLoading(true)
      const error = await saveDetails()
      setLoading(false)
      if (error) {
        setStepError(error)
        return
      }
      setStep(2)
      return
    }

    if (step === 2) {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        await expireSession()
        return
      }
      const updated = await updateJobTypes()
      setLoading(false)
      if (!updated) {
        setStepError('could not save job types. please try again.')
        return
      }
      setStep(3)
      return
    }

    if (step === 3) {
      if (uploadStage === 'saved' && resumeId) setStep(4)
      return
    }

    // step 4 -> complete
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setLoading(false)
      await expireSession()
      return
    }
    if (!resumeId) {
      setLoading(false)
      setStepError('resume not found. please try again.')
      return
    }
    const saved = await saveInterests()
    if (!saved) {
      setLoading(false)
      setStepError('could not save interests/search terms. please try again.')
      return
    }
    setLoading(false)
    handleComplete()
  }

  const prevStep = () => {
    if (step > 1) {
      setStepError(null)
      setStep(step - 1)
    }
  }

  const uploadResume = async (file: File) => {
    uploadController.current?.abort()
    const controller = new AbortController()
    uploadController.current = controller
    const { signal } = controller

    setResumeId(null)
    setStepError(null)
    setUploadStage('presigning')

    // Each pick replaces the last one, so drop the previous row before its replacement
    // is saved and claims the primary pointer.
    const replacedId = uploadedResumeId.current
    uploadedResumeId.current = null
    if (replacedId) {
      await api.del(`/me/resumes/${replacedId}`).catch(() => undefined)
    }

    const fail = (message: string) => {
      if (signal.aborted) return
      setUploadStage('failed')
      setStepError(message)
    }

    let presigned: { uploadUrl: string; key: string; resumeId: string }
    try {
      const response = await api.post('/me/resumes/upload', {
        file_name: file.name,
        file_type: file.type,
        file_size: file.size
      }, { signal })
      if (!response.ok) return fail('could not start the upload. please try again.')
      presigned = await response.json()
      uploadedResumeId.current = presigned.resumeId
    } catch {
      return fail('could not reach the server. check your connection and try again.')
    }

    if (signal.aborted) return
    setUploadStage('uploading')
    try {
      const response = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
        signal
      })
      if (!response.ok) return fail('could not upload your file. please try again.')
    } catch {
      return fail('could not upload your file. check your connection and try again.')
    }

    if (signal.aborted) return
    setUploadStage('saving')
    try {
      const response = await api.post('/resumes/save', {
        resume_id: presigned.resumeId,
        key: presigned.key,
        file_name: file.name,
        file_size_bytes: file.size
      }, { signal })
      if (!response.ok) return fail('could not read your resume. make sure it is a valid PDF and try again.')
    } catch {
      return fail('could not reach the server. check your connection and try again.')
    }

    if (signal.aborted) return
    setResumeId(presigned.resumeId)
    setUploadStage('saved')
  }

  const handleFileSelect = (file: File) => {
    if (file.type !== 'application/pdf') {
      setStepError('only PDF files are supported.')
      return
    }
    setUploadedFile(file)
    void uploadResume(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)

    const file = e.dataTransfer.files[0]
    if (file) {
      handleFileSelect(file)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) {
      handleFileSelect(file)
    }
  }

  return (
    <div className="onboarding-container page-stagger">
      <div className="onboarding-content stagger-children">
        <div className="onboarding-progress">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${(step / 4) * 100}%` }}
            />
          </div>
          <span className="progress-text">step {step} of 4</span>
        </div>

        {step === 1 && (
          <div className="onboarding-step">
            <h1 className="onboarding-title">welcome</h1>
            <p className="onboarding-description">
              let's start with the basics.
            </p>
            <div className="onboarding-form">
              <input
                type="text"
                placeholder="first name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="onboarding-input"
              />
              <input
                type="text"
                placeholder="last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="onboarding-input"
              />
              <input
                type="number"
                placeholder="graduation year"
                value={gradYear}
                onChange={(e) => setGradYear(e.target.value)}
                className="onboarding-input"
                min="2000"
                max="2040"
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step">
            <h1 className="onboarding-title">what type of job are you looking for?</h1>
            <p className="onboarding-description">
              choose one or more options that match the roles you want.
            </p>
            <div className="interests-grid">
              {jobTypes.map((type, index) => (
                <span
                  key={index}
                  className={`interest-tag ${selectedJobTypes.includes(type) ? 'interest-tag--selected' : ''}`}
                  onClick={() => toggleJobType(type)}
                >
                  {type}
                </span>
              ))}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboarding-step">
            <h1 className="onboarding-title">upload your resume</h1>
            <p className="onboarding-description">
              AI agents parse your resume to find jobs that best match your strengths.
            </p>
            <div
              className={`upload-zone ${isDragging ? 'dragging' : ''} ${uploadedFile ? 'has-file' : ''}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <input
                id="file-input"
                type="file"
                accept=".pdf"
                onChange={handleFileInput}
                style={{ display: 'none' }}
              />
              {!uploadedFile ? (
                <>
                  <div className="upload-icon">📄</div>
                  <p className="upload-text">
                    drag and drop your resume here
                  </p>
                  <p className="upload-subtext">or click to browse</p>
                  <p className="upload-format">PDF files only</p>
                </>
              ) : (
                <div className="uploaded-file">
                  <div className="file-info">
                    <span className="file-icon">📄</span>
                    <span className="file-name">{uploadedFile.name}</span>
                  </div>
                  {uploadStage && UPLOAD_STAGE_LABELS[uploadStage] && (
                    <p className="upload-status">{UPLOAD_STAGE_LABELS[uploadStage]}</p>
                  )}
                  <p className="upload-format">click or drop a file to replace</p>
                </div>
              )}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboarding-step">
            <h1 className="onboarding-title">select your interests</h1>
            <p className="onboarding-description">
              we'll use these to filter jobs for you.
            </p>
            <div className="interests-grid">
              {interests.map((interest) => (
                <span
                  key={interest}
                  className={`interest-tag ${selectedInterests.includes(interest) ? 'interest-tag--selected' : ''}`}
                  onClick={() => toggleInterest(interest)}
                >
                  {interest}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="onboarding-actions">
          {step > 1 && (
            <button
              onClick={prevStep}
              className="onboarding-button onboarding-button--secondary"
            >
              back
            </button>
          )}
          <button
            onClick={nextStep}
            className="onboarding-button onboarding-button--primary"
            disabled={
              loading ||
              (step === 1 && (!firstName.trim() || !lastName.trim() || !gradYear.trim())) ||
              (step === 2 && selectedJobTypes.length === 0) ||
              (step === 3 && uploadStage !== 'saved') ||
              (step === 4 && selectedInterests.length === 0)
            }
          >
            {loading ? 'loading...' : step === 4 ? 'finish' : 'next'}
          </button>
        </div>
        {stepError && <p className="onboarding-error">{stepError}</p>}
      </div>
    </div>
  )
}