type PageHeaderProps = {
  title: string;
  description?: string;
  action?: React.ReactNode;
};

export function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <div className="mb-6 border-b border-slate-100 pb-5 flex items-start justify-between">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-slate-900">{title}</h1>
        {description && (
          <p className="mt-1 text-[14px] text-slate-500">{description}</p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
