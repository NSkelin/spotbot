# declare cmdId=$(aws ssm send-command \
# --document-name "AWS-RunShellScript" \
# --comment "Copy data to S3 as backup / save" \
# --instance-ids "i-05c740b57558b86d9" \
# --parameters '{"commands":["pgrep java"]}' \
# --region us-west-2 \
# --query "Command.CommandId" \
# --output text)
# sleep 1
# declare pidId=$(aws ssm get-command-invocation \
# --command-id $cmdId \
# --instance-id "i-05c740b57558b86d9" \
# --query "StandardOutputContent" \
# --output text)

# echo $pidId
# sleep 1

# declare cmdId2=$(aws ssm send-command \
# --document-name "AWS-RunShellScript" \
# --comment "Copy data to S3 as backup / save" \
# --instance-ids "i-05c740b57558b86d9" \
# --parameters '{"commands":["ps $pidId"]}' \
# --region us-west-2 \
# --query "Command.CommandId" \
# --output text)

# declare pidId2=$(aws ssm get-command-invocation \
# --command-id $cmdId2 \
# --instance-id "i-05c740b57558b86d9" \
# --query "StandardOutputContent" \
# --output text)

# echo $pidId2

aws ec2 describe-instances --filter Name=tag:Name,Values=ttt --query Reservations[0].Instances