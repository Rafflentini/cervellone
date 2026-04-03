import Image from 'next/image'

export default function CervelloneLogo({ size = 48 }: { size?: number }) {
  return (
    <Image
      src="/logo.png"
      alt="Cervellone"
      width={size}
      height={size}
      className="rounded-full"
      priority
    />
  )
}
